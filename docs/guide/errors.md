---
title: The error envelope
description: One shape for every Kata error — the 422 validation envelope, the 500 output mismatch, and custom statuses via c.error / c.json.
---

# The error envelope

Kata produces **one** error shape. Every 4xx and 5xx response — validation failures,
your own domain errors, output mismatches, uncaught throws — comes back as the same
JSON envelope:

```ts
type ErrorBody = {
  error: string                          // stable, machine-readable code
  message: string                        // human-readable description
  issues?: Record<string, FieldIssue[]>  // structured field errors, keyed by input section
}
```

- `error` — the discriminator a client switches on (`'not_found'`,
  `'validation_failed'`, `'internal_error'`). It never holds a human sentence.
- `message` — a human-readable description. Always present.
- `issues` — present only when there are structured field errors (today: input
  validation).

Why force every failure into one shape? Because it lets a client write **one** error
handler instead of one per endpoint. Whatever goes wrong, the caller reads `error` to
decide what happened and `message` to show a human — never guessing at a different
body shape for each route. And this is enforced by the runtime, not by convention:
both ends of every route are validated, and each failure mode maps to this envelope.
The two automatic ones come first; the ones you write come after.

| Stage | When | On failure |
|---|---|---|
| **Input** | before the handler runs | `422` `validation_failed` |
| **Handler throws** | any escape from middleware or handler | `500` `internal_error` |
| **Output** | after the handler returns a value | `500` `internal_output_shape_mismatch` (mode-dependent) |
| **Your 4xx** | you `return c.error(...)` / `c.json(...)` | your status |

A request whose body is non-empty but not valid JSON is rejected before the input
stage with `400` `validation_failed` (`message: "Malformed JSON body"`); an empty or
absent body instead reads as `undefined` and lets the schema decide.

## The 422 validation envelope

`input` is validated **before** your handler — a `422` is Kata's way of saying "you
sent something the route's `input` schema rejected." On failure Kata never calls the
handler; it responds `422` with `error: "validation_failed"`, the message
`"Request input validation failed"`, and an `issues` object **keyed by the input
section** that failed (`params` / `query` / `body` / `headers`). Each key holds an
array of field issues.

For the `POST /users` body `{ "name": "", "email": "not-an-email" }` against
`CreateUserBodySchema`, the response is (this shape is asserted by
[`examples/hello`](/guide/quickstart)'s `users.hurl`; the literal `message` strings
are Zod's):

```json
{
  "error": "validation_failed",
  "message": "Request input validation failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "String must contain at least 1 character(s)" },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

### The `FieldIssue` shape

Every entry under `issues` is a `FieldIssue`:

```ts
type FieldIssue = {
  path: string       // dot/bracket path: "email", "user.profile.age", "items[1].qty"
  message: string    // Zod's human-readable message
  code: string       // Zod issue code: "too_small", "invalid_type", "invalid_string", …
  expected?: unknown // present only when the Zod issue carries it (type errors)
  received?: unknown // present only when the Zod issue carries it (type errors)
}
```

Rules to keep straight:

- `path` uses dot notation for nested objects and `[n]` for array indices. A
  root-level error has an empty `path: ""`.
- `expected` / `received` appear **only** when the underlying Zod issue carries them
  (i.e. `invalid_type`) and are omitted otherwise.
- Issues are reported in source order. When more than one section is invalid (e.g.
  both `params` and `body`), each gets its own key under `issues`.

::: tip Reuse the formatter
If you validate something yourself — a webhook payload, a re-parsed query, a
cross-field rule — and want the response to match this exact shape,
`formatZodIssues(error: ZodError): FieldIssue[]` is exported from `katajs`. Build the
envelope with `c.error('validation_failed', 'Request input validation failed', { status: 422, issues: { body: formatZodIssues(parsed.error) } })`.
:::

## Output validation and `internal_output_shape_mismatch`

When your handler returns a **plain value** (not a `Response`), Kata runs it through
the route's `output` schema before serialising — a last check that the server is
actually sending the shape it promised. What happens on a mismatch is deliberately
configurable, because the right reaction differs by environment; it is set by the
app's `outputValidation` mode ([ADR-0009](/adr/0009-output-validation-mode)):

| Mode | On mismatch | Intended environment |
|---|---|---|
| `strict` | Log the issues, return `500` `internal_output_shape_mismatch` | dev / test / CI |
| `log` | Log the issues, send the handler's data through unchanged | production |
| `off` | Skip output validation entirely | perf-critical opt-out |

The three modes trace the tension between *catching bugs* and *staying up*: `strict`
fails loudly, so a wrong shape can never slip past in dev or CI; `log` keeps
production serving, letting a benign drift become a log line instead of an outage;
`off` removes the check entirely where every microsecond counts.

The mode is resolved once at `createApp`, first match wins:

1. the explicit `outputValidation` passed to `createApp`,
2. the `KATA_OUTPUT_VALIDATION` env var when it names a valid mode,
3. derived from `NODE_ENV` — `production` → `log`, otherwise `strict`.

```ts
const app = createApp({ modules: [users], outputValidation: 'strict' })
```

In `strict` mode the Zod issues are logged server-side (through your injected
`logger` if one is registered, else `console.error`) and the response is exactly:

```json
{ "error": "internal_output_shape_mismatch", "message": "Response did not match the declared output schema" }
```

with status `500`. This catches "the handler returned _almost_ the right shape"
before it reaches a client. In `log` mode the issues are still logged, but the
handler's data is sent through unchanged — a benign shape drift in production degrades
to a log line instead of a hard 500. In `off` mode there is no `safeParse` and no Zod
transform; the data passes through as-is.

::: warning The mismatch is never leaked to the client
On a `strict` mismatch the client receives the generic `internal_output_shape_mismatch`
envelope. The offending Zod issues are logged server-side only — field names and
internal shape never cross the wire.
:::

## Uncaught throws: `internal_error`

A throw that escapes any middleware or handler is caught by Kata's global error
boundary and serialised through the same envelope:

```json
{ "error": "internal_error", "message": "Internal server error" }
```

with status `500` and `Content-Type: application/json` — never Hono's default
text/HTML 500 page. That boundary exists so a bug can never leak a stack trace or an
HTML error page to a client: the raw error is logged server-side, and the underlying
message is never surfaced.

Reserve throwing for genuine bugs. For failures the client should understand, return
`c.error(...)`.

## Custom statuses: `c.error` and `c.json`

For domain errors — not found, forbidden, conflict — **return a `Response`** from the
handler. The idiomatic way is `c.error(code, message, extra?)`, which builds the
unified envelope; `c.json(value, status?)` is the escape hatch for a custom shape.
Both are available on the route **and** middleware contexts.

```ts
return c.error('not_found', 'No user with that id', { status: 404 })
// → 404  { "error": "not_found", "message": "No user with that id" }
```

`c.error`'s signature:

```ts
c.error(code: string, message: string, extra?: ErrorExtra): Response

type ErrorExtra = {
  status?: number                        // defaults to 400
  issues?: Record<string, FieldIssue[]>  // attach structured field errors
}
```

- The `code` argument becomes the wire `error` field.
- `status` rides inside `extra` and **defaults to `400`**.
- Attach structured field errors via `extra.issues` (the same `FieldIssue[]` shape as
  the 422 envelope).

The distinction that governs the response pipeline (the same one from
[Routes & schemas](/guide/routes-schemas)):

- **return a value** → validated against `output`, sent as `200`.
- **return `c.error(...)` / `c.json(body, status)`** → carries its own status.

### Returned responses and the `output` schema

With a **single** `output` schema, a returned `Response` (including `c.error`)
short-circuits the route and is **not** checked against it — which is precisely why an
error body is allowed to differ from your success shape.

```ts
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 }) // not validated
    return user                                                               // validated against UserSchema
  },
})
```

To type **and** validate error bodies too, declare `output` as a status→schema map
([ADR-0011](/adr/0011-multi-status-output-schemas)). Kata ships `ErrorBodySchema` for
exactly this — the Zod mirror of the unified envelope:

```ts
import { ErrorBodySchema } from 'katajs'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})
```

In the map form: a plain return is the `200` body; `c.json(body, 201)` is validated
against `output[201]`; a `c.error(...)` whose status is declared is validated against
that status's schema. **Undeclared statuses still pass through** unvalidated. The
original `Response` is forwarded verbatim on success — Kata never re-serialises a
response your handler built, so a header or content type you set is preserved. The RPC
client narrows by status: `InferResponseType<call, 404>`. See
[`defineRoute`](/reference/define-route) for the full `output` contract.

## What's automatic vs. what you write

| Situation | Status | Who produces it |
|---|---|---|
| Input fails its schema | `422` | Kata (automatic) |
| Handler returns a value matching `output` | `200` | Kata |
| Handler returns `c.error(...)` / `c.json(body, status)` | your status | you |
| Handler return value fails `output` | `500` (mode-dependent) | Kata (automatic) |
| Handler **throws** | `500` | Kata's error boundary |

## Gotchas

- **A malformed JSON body returns `400`** `validation_failed` (`message: "Malformed
  JSON body"`) **before** schema validation — the unparseable bytes never reach your
  `body` schema. An *empty or absent* body is different: it reads as `undefined`, so
  the `body` schema decides (an optional body passes; a required one → `422`).
- **Every response carries a correlation id.** Success or error, Kata echoes an
  `X-Request-Id` header (reusing a well-formed inbound one, otherwise a fresh UUID).
  See [Lifecycle](/guide/lifecycle).
- **`status` is not a positional argument on `c.error`.** It lives inside `extra` and
  defaults to `400` — `c.error('not_found', '…')` without a status returns `400`, not
  `404`.

## See also

- [`defineRoute`](/reference/define-route) — the `input` / `output` contract.
- [Errors cookbook](/cookbook/errors) — worked recipes for returning your own 4xx.
