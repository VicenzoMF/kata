# Recipe: Errors & validation

**Problem:** return correct, predictable error responses — and understand the two
envelopes Kata produces automatically.

Kata validates both ends of every route ([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)):

| Stage | When | On failure |
|---|---|---|
| **Input** | before the handler runs | `422` `validation_failed` envelope (below) |
| **Output** | after the handler returns a value | `500` `internal_output_shape_mismatch` |

Everything else — your own 4xx — you return explicitly from the handler.

## The 422 validation envelope

When request input fails its schema, Kata never calls your handler. It responds
`422` with a fixed shape: a top-level `error` discriminator plus an `issues`
object **keyed by the input section** (`params` / `query` / `body` / `headers`),
each holding an array of field issues.

For the `POST /users` body `{ "name": "", "email": "not-an-email" }` against
`CreateUserBodySchema`, the response is exactly (asserted in
[`users.hurl`](../../examples/hello/src/modules/users/users.hurl)):

```json
{
  "error": "validation_failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "..." },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Each entry is a `FieldIssue`, defined in
[`packages/kata/src/errors.ts`](../../packages/kata/src/errors.ts):

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
the handler with `c.json(body, status)`. Returning a `Response` short-circuits
the route: Kata sends it as-is and does **not** validate it against the `output`
schema — which is precisely why an error body may differ from your success shape.

```ts
// not found — mirrors examples/hello
handler: async (c) => {
  const user = await findUser(c.get('db'), c.input.params.id)
  if (!user) return c.json({ error: 'not_found' }, 404)
  return user // a plain value IS validated against `output`
}
```

The same applies inside middleware (e.g. the `401` in [auth.md](./auth.md)).
The distinction to keep straight:

- **return a value** → validated against `output`, sent as `200`.
- **return `c.json(body, status)`** → sent verbatim, any status, not validated.

## Reusing the framework's issue formatter

If you validate something yourself — a webhook payload, a parsed query you
post-process, a cross-field rule — and want your response to match Kata's 422
shape, the formatter is exported. `formatZodIssues(error)` turns a `ZodError`
into `FieldIssue[]`:

```ts
import { formatZodIssues } from 'kata'

handler: async (c) => {
  const parsed = WebhookSchema.safeParse(await c.raw.req.json())
  if (!parsed.success) {
    return c.json(
      { error: 'validation_failed', issues: { body: formatZodIssues(parsed.error) } },
      422,
    )
  }
  // … parsed.data is typed
}
```

This keeps hand-rolled validation responses byte-compatible with the automatic
ones, so clients parse a single shape.

## Output validation (the 500 envelope)

After your handler returns a **value**, Kata runs it through the route's `output`
schema. A mismatch is a server bug, so it logs the Zod issues to `console.error`
and responds:

```json
{ "error": "internal_output_shape_mismatch" }
```

with status `500`. This catches "handler returned _almost_ the right shape"
before it reaches a client. The dev-vs-prod behaviour (throw loudly in
development, log in production) is being formalised in
[#17](https://github.com/VicenzoMF/kata/issues/17).

## What's automatic vs. what you write

| Situation | Status | Who produces it |
|---|---|---|
| Input fails its schema | `422` | Kata (automatic) |
| Handler returns a value matching `output` | `200` | Kata |
| Handler returns `c.json(body, status)` | your `status` | you |
| Handler return value fails `output` | `500` | Kata (automatic) |
| Handler **throws** | generic `500` | Hono (see below — _not_ the envelope yet) |

## Planned: a unified error envelope

Today error bodies are deliberately small and ad-hoc — `{ error: 'not_found' }`,
`{ error: 'unauthorized' }`. A single envelope shape and a `c.error` helper are
**planned, not shipped**:

```ts
// Planned — tracked in #18, do NOT use yet.
return c.error('not_found', 'No user with that id', { id })
// → { "error": "not_found", "message": "No user with that id", "code": ... }
```

See [#18 — ADR + impl: unified error response envelope](https://github.com/VicenzoMF/kata/issues/18).
Until it ships, return `c.json(body, status)` with your own small shape (keeping
a top-level `error` string keeps you forward-compatible).

## Gotchas

- **Throwing from a handler does _not_ produce the envelope today.** There is no
  global try/catch around handlers yet, so an uncaught throw becomes Hono's
  generic `500`, not a Kata envelope. For controlled failures, **return a
  `Response`** instead of throwing. A global error boundary that catches throws
  and renders the envelope is tracked in
  [#62](https://github.com/VicenzoMF/kata/issues/62).
- **`output` is a single success schema.** Error `Response`s bypass it, so you
  don't need to widen `output` to cover them. If a route genuinely has multiple
  _success_ shapes, widen `output` to a union for now; per-status output schemas
  (`200: User, 404: ErrorShape`) are tracked in
  [#19](https://github.com/VicenzoMF/kata/issues/19).
- **A malformed JSON body reads as `undefined`**, then fails its `body` schema —
  so it surfaces as a normal `422`, not a parse crash.
