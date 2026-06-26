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
import { formatZodIssues } from 'katajs'

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
