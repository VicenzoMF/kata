# Recipe: Errors & validation

**Problem:** return correct, predictable error responses — and understand the two
envelopes Kata produces automatically.

Kata validates both ends of every route ([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)):

| Stage | When | On failure |
|---|---|---|
| **Input** | before the handler runs | `422` `validation_failed` envelope (below) |
| **Output** | after the handler returns a value | `500` `internal_output_shape_mismatch` |

A non-empty body that is not valid JSON is rejected even earlier, with `400`
`validation_failed` (`message: "Malformed JSON body"`) — before the input stage,
so it never reaches your `body` schema. (An empty or absent body still reads as
`undefined` and lets the schema decide.)

Everything else — your own 4xx — you return explicitly from the handler.

## The 422 validation envelope

When request input fails its schema, Kata never calls your handler. It responds
`422` with a fixed shape: a top-level `error` discriminator, a human-readable
`message`, and an `issues` object **keyed by the input section** (`params` /
`query` / `body` / `headers`), each holding an array of field issues.

For the `POST /users` body `{ "name": "", "email": "not-an-email" }` against
`CreateUserBodySchema`, the response is exactly (asserted in
[`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl)):

```json
{
  "error": "validation_failed",
  "message": "Request input validation failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "..." },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Each entry is a `FieldIssue`, defined in
[`packages/kata/src/errors.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/errors.ts):

```ts
export type FieldIssue = {
  path: string // dot/bracket path: "email", "user.profile.age", "items[1].qty"
  message: string // Zod's human-readable message
  code: string // Zod issue code: "too_small", "invalid_type", …
  expected?: unknown // present only on type errors
  received?: unknown // present only on type errors
}
```

Notes:
- `path` uses dot notation for nested objects and `[n]` for array indices; a
  root-level error has an empty `path: ""`.
- `expected` / `received` appear **only** when the underlying Zod issue carries
  them (i.e. `invalid_type`), and are omitted otherwise.
- Issues are reported in source order; multiple bad sections (e.g. both `params`
  and `body`) each get their own key under `issues`.

## Returning your own 4xx

For domain errors (not found, forbidden, conflict…), **return a `Response`** from
the handler. The idiomatic way is `c.error(code, message, { status })`, which
builds Kata's unified envelope (see [below](#the-unified-error-envelope-cerror));
`c.json(body, status)` is the escape hatch for a custom shape. Either way,
returning a `Response` short-circuits the route: Kata sends it as-is and does
**not** validate it against the `output` schema — which is precisely why an error
body may differ from your success shape.

```ts
// not found — mirrors examples/hello
handler: async (c) => {
  const user = await findUser(c.get('db'), c.input.params.id)
  if (!user) return c.error('not_found', 'User not found', { status: 404 })
  return user // a plain value IS validated against `output`
}
```

The same applies inside middleware (e.g. the `401` in [auth.md](./auth.md)).
The distinction to keep straight:

- **return a value** → validated against `output`, sent as `200`.
- **return `c.error(...)` / `c.json(body, status)`** → sent verbatim, any status, not validated.

## Reusing the framework's issue formatter

If you validate something yourself — a webhook payload, a parsed query you
post-process, a cross-field rule — and want your response to match Kata's 422
shape, the formatter is exported. `formatZodIssues(error)` turns a `ZodError`
into `FieldIssue[]`:

```ts
import { formatZodIssues } from '@katajs-framework/core'

handler: async (c) => {
  const parsed = WebhookSchema.safeParse(await c.raw.req.json())
  if (!parsed.success) {
    return c.error('validation_failed', 'Request input validation failed', {
      status: 422,
      issues: { body: formatZodIssues(parsed.error) },
    })
  }
  // … parsed.data is typed
}
```

This keeps hand-rolled validation responses byte-compatible with the automatic
ones, so clients parse a single shape.

## Output validation (the 500 envelope)

After your handler returns a **value**, Kata runs it through the route's `output`
schema. How a mismatch is handled is set by the `outputValidation` mode
([ADR-0009](../adr/0009-output-validation-mode.md)): `strict` (log + `500`),
`log` (log, but send the handler's data through unchanged), or `off` (skip
validation). It defaults to `strict` outside production and `log` in production,
and is overridable via `createApp({ outputValidation })` or the
`KATA_OUTPUT_VALIDATION` env var.

In `strict` mode the Zod issues are logged server-side (through your injected
`logger` if one is registered, else `console.error`) and the response is:

```json
{ "error": "internal_output_shape_mismatch", "message": "Response did not match the declared output schema" }
```

with status `500` — catching "handler returned _almost_ the right shape" before
it reaches a client. In `log` mode the issues are still logged, but the handler's
data is sent through, so a shape bug in production degrades to a log line rather
than a failed response.

## Testing the error boundary without a crash route

**Problem:** you want a test that asserts Kata's `500` `internal_error` envelope
(the last row of the table above) — but the only way to trigger it is a route
that throws, and a dedicated `GET /diagnostics/boom` living in `main.ts`'s
`modules: [...]` array would ship as a standing "crash the server on purpose"
endpoint, reachable in production.

**Solution:** call `createApp`/`defineRoute` a second time — the same factory
functions `main.ts` uses, from the same `./context` — but do it *inside the
test file*, on a throwaway route that is never exported and never added to the
app's real `modules` array. `createApp` just builds a `Hono` app from whatever
`modules` you hand it; nothing requires that array to be the one `main.ts`
actually serves:

```ts
// examples/hello/src/error-boundary.test.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createApp, defineRoute } from './context' // the app's own factory + registry

// Defined only here — not in a `*.route.ts` file, so it's never imported by
// main.ts and never registered on the app that actually listens on a port.
const crashRoute = defineRoute({
  method: 'GET',
  path: '/__test-only/boom',
  input: {},
  output: z.object({ ok: z.boolean() }),
  handler: () => {
    throw new Error('forced failure — error-boundary test only')
  },
})

describe('error boundary: forcing a 500 without a shipped crash route', () => {
  it('turns a thrown handler error into the unified internal_error envelope', async () => {
    // Only the test-local route — main.ts's real modules ([users, auth, echo,
    // diag]) are never imported here.
    const app = createApp({ modules: [{ crashRoute }] })
    const res = await app.request('/__test-only/boom')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Internal server error',
    })
  })
})
```

This exercises the real code path — the same `registerRoute` try/catch and
`app.onError` fallback the shipped app runs, wired through the same
`defineContext` registry — without adding a single route to `main.ts`'s
`modules` array. The `Hono` app built here lives only for the duration of the
test; it is never `serve()`d, so `/__test-only/boom` is never reachable outside
`vitest run`. Kata's own suite covers the error boundary the identical way
(`packages/kata/src/context.test.ts`, `describe('global error boundary (#62)')`):
a throwaway `defineContext({})` and a `/boom` route built inline in the test.

::: tip Prefer this over an injectable failing dependency
If a route already depends on something registered via `defineContext` — a
`db` singleton, a `mailer` — swapping it for a version that throws, in one
test, is a legitimate way to cover *that handler's* failure path. It doesn't
generalize the same way, though: it only works for routes that happen to have
a fallible dependency to poison. The test-only module above needs nothing
route-specific, so it's the default recommendation for asserting the error
boundary itself; reach for a failing-dependency mock when you're testing one
handler's specific failure mode instead.
:::

## Testing the error boundary over real HTTP (Hurl/curl)

**Problem:** the section above solves the Vitest case, but an E2E suite that
drives the app over **real HTTP** — Hurl, curl, Playwright, anything
out-of-process — can't reuse it. `createApp({ modules: [{ crashRoute }] })` in
`error-boundary.test.ts` builds a real `Hono` app object, but the test never
calls `serve()` on it: nothing binds a port, so there is no `http://localhost`
for a `.hurl` file (or any other external tool) to send a request to. The
route only exists for the duration of `app.request(...)`, in-process, inside
`vitest run`.

There is no way around this that keeps the crash route unreachable: an
out-of-process tool can only hit a route that is part of the server
`main.ts` actually boots — i.e. something in the real `modules` array. Making
the `500`/`internal_error` envelope exercisable from real HTTP therefore
requires, unavoidably, a route that throws and *is* reachable in production.

**Solution:** accept that trade-off explicitly, once, instead of leaving each
consumer to reinvent it — and contain it in a diagnostics-flavored module
rather than scattering it across the app. `examples/hello` does this with a
`GET /boom` route in its existing
[`diag`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/diag/diag.route.ts)
module (already wired into `main.ts`'s `modules: [users, auth, echo, diag]`
array alongside the request-id and CSV-export diagnostics routes):

```ts
// examples/hello/src/modules/diag/diag.route.ts
export const boomRoute = defineRoute({
  method: 'GET',
  path: '/boom',
  input: {},
  output: BoomOutputSchema, // never actually returned — the handler always throws
  handler: () => {
    throw new Error('forced failure — diag.boom is a standing crash route for real-HTTP E2E coverage')
  },
})
```

Asserted end to end in
[`diag.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/diag/diag.hurl)
against the actually-listening server (`pnpm --filter=hello start`, then
`pnpm --filter=hello hurl`):

```hurl
GET http://localhost:3000/boom
HTTP 500
[Asserts]
jsonpath "$.error" == "internal_error"
jsonpath "$.message" == "Internal server error"
```

**This is a standing, production-reachable "crash the server on purpose"
endpoint** — the exact thing the previous section's Vitest-only route was
built to avoid. That's a deliberate, accepted trade-off for real-HTTP E2E
coverage, not an oversight: keep it to a single unconditional throw with no
business logic, isolate it in a diagnostics-style module (so it reads as
infrastructure, not a feature), and don't be surprised when a security scan or
a teammate flags `GET /boom` — that's the cost of this coverage, paid
knowingly. If that cost is unacceptable for your deployment, gate the route
behind an environment check (e.g. only register it when `NODE_ENV !==
'production'`) and run the real-HTTP assertion against a non-production build
instead.

## What's automatic vs. what you write

| Situation | Status | Who produces it |
|---|---|---|
| Input fails its schema | `422` | Kata (automatic) |
| Handler returns a value matching `output` | `200` | Kata |
| Handler returns `c.error(...)` / `c.json(body, status)` | your `status` | you |
| Handler return value fails `output` | `500` | Kata (automatic) |
| Handler **throws** | `500` | Kata's error boundary — unified `internal_error` envelope |

## The unified error envelope: `c.error`

For domain errors, prefer `c.error(code, message, extra?)` over a hand-rolled
`c.json`. It builds Kata's single error envelope — the `{ error, message,
issues? }` shape every 4xx/5xx Kata produces
([ADR-0008](../adr/0008-unified-error-response-envelope.md)):

```ts
return c.error('not_found', 'No user with that id', { status: 404 })
// → 404  { "error": "not_found", "message": "No user with that id" }
```

`c.error` is available on both the route and middleware contexts. The `code`
argument becomes the wire `error` field; `status` defaults to `400`; attach
structured field errors via `extra.issues` (the same `FieldIssue[]` shape as the
422 envelope above). With a single `output` schema, a returned `Response`
(`c.error` included) short-circuits the route and is **not** checked against it;
declare a status→schema map (see _Gotchas_) to type and validate error bodies too.

## Gotchas

- **A thrown error becomes an opaque `500`.** Kata's global error boundary
  catches any throw that escapes a handler or middleware and serialises it as a
  unified `{ "error": "internal_error", "message": "Internal server error" }`
  envelope (status `500`) — never Hono's default text/HTML page, and never
  leaking the underlying message. Prefer `c.error(...)` for failures the client
  should understand, and reserve throwing for genuine bugs.
- **`output` can be a single schema or a status→schema map (ADR-0011).** A single
  schema is the 200 body, and returned `Response`s bypass it. To type _and_
  validate other statuses, declare a map —
  `output: { 200: UserSchema, 404: ErrorBodySchema }` (Kata ships `ErrorBodySchema`
  for the unified envelope). Then a plain return is the 200 body, `c.json(body, 201)`
  is validated against `output[201]`, and a `c.error(...)` whose status is declared
  is validated against that status's schema. Undeclared statuses still pass through.
  `hc<typeof app>` narrows responses by status: `InferResponseType<call, 404>`.
- **A malformed JSON body returns `400`** `validation_failed` (`message:
  "Malformed JSON body"`) **before** schema validation runs — the unparseable
  bytes never reach your `body` schema. An *empty or absent* body is different:
  it reads as `undefined`, so the `body` schema decides the outcome (an optional
  body passes; a required one fails its schema → `422`).
