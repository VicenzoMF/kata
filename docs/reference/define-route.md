---
title: defineRoute
description: API reference for defineRoute — the route config type, input and output schemas, the handler context, and validation behavior.
---

# defineRoute

`defineRoute` declares one route: an HTTP method, a path, the schemas for what
enters and leaves it, an optional middleware chain, and a handler. It is
returned by [`defineContext`](/reference/define-context), bound to your
registry — not imported globally — so `c.get('key')` inside the handler only
type-checks for keys you registered.

```ts
import { defineRoute } from '../../context'

import { EchoBodySchema, EchoResponseSchema } from './echo.schema'

export const echoRoute = defineRoute({
  method: 'POST',
  path: '/echo',
  input: { body: EchoBodySchema },
  output: EchoResponseSchema,
  handler: (c) => ({ echoed: c.input.body.message }),
})
```

`defineRoute` returns a `Route` value. A `.route.ts` file holds `defineRoute`
calls and nothing else; [`createApp`](/reference/create-app) collects each
exported route through a namespace import of the file.

## Signature

```ts
function defineRoute<
  const M extends HttpMethod,
  const P extends string,
  const I extends InputSchemas,
  const O extends OutputSpec,
>(config: {
  method: M
  path: P
  use?: readonly Middleware<R>[]
  input: I
  output: O
  handler: (c: RouteContext<R, I>) => Promise<RouteHandlerReturn<O>> | RouteHandlerReturn<O>
}): Route<R, M, P, I, O>
```

`R` is the registry the enclosing `defineContext` was called with. `M`, `P`,
`I`, and `O` are inferred as the narrowest types from the literal you pass
(`const` type parameters), so `method` and `path` flow into the typed RPC
client, and `c.input` is typed exactly from `input`.

| Field     | Type                       | Required | Notes |
|-----------|----------------------------|----------|-------|
| `method`  | `HttpMethod`               | yes      | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` |
| `path`    | `string`                   | yes      | A Hono path string, e.g. `'/users/:id'` |
| `input`   | `InputSchemas`             | yes      | `{ params?, query?, body?, headers? }`; `{}` is valid |
| `output`  | `OutputSpec`               | yes      | A single Zod schema or a status→schema map |
| `use`     | `readonly Middleware<R>[]` | no       | Defaults to `[]`; runs before the handler |
| `handler` | `(c) => …`                 | yes      | Returns a value or a `Response` |

`input` and `output` are both mandatory — omitting either is a TypeScript error
([ADR-0003](/adr/0003-mandatory-input-output-schemas)). `use` defaults to `[]`
when omitted; app-level middleware declared on `createApp` runs before it
([App middleware](/guide/app-middleware)).

## `input`

`input` is an object with any of four optional keys, each a Zod schema:

```ts
type InputSchemas = {
  params?: z.ZodTypeAny
  query?: z.ZodTypeAny
  body?: z.ZodTypeAny
  headers?: z.ZodTypeAny
}
```

Each key maps to a part of the request, read and validated before the handler:

| Key       | Source                                |
|-----------|---------------------------------------|
| `params`  | path parameters (`/users/:id`)        |
| `query`   | URL query string                      |
| `body`    | parsed JSON request body              |
| `headers` | request headers, keys lowercased      |

Declare only the sections the route reads. A route that reads none still
declares `input` explicitly as `{}` — the contract for "this route takes no
input".

```ts
export const requestIdRoute = defineRoute({
  method: 'GET',
  path: '/request-id',
  input: {},
  output: RequestIdResponseSchema,
  handler: (c) => ({ requestId: c.requestId }),
})
```

### `c.input`

Inside the handler, `c.input` has one property per section, typed from its
schema (`z.infer`). A section you did not declare is typed `undefined`:

```ts
type InferInput<I extends InputSchemas> = {
  params: I['params'] extends z.ZodTypeAny ? z.infer<I['params']> : undefined
  query: I['query'] extends z.ZodTypeAny ? z.infer<I['query']> : undefined
  body: I['body'] extends z.ZodTypeAny ? z.infer<I['body']> : undefined
  headers: I['headers'] extends z.ZodTypeAny ? z.infer<I['headers']> : undefined
}
```

So `c.input.params.id` type-checks only when `input.params` is declared. The
values are the **parsed** output of each schema — Zod transforms, coercions, and
defaults have already been applied.

## `output`

`output` is either a single Zod schema or a map from HTTP status code to schema:

```ts
type OutputMap = { readonly [status: number]: z.ZodTypeAny }
type OutputSpec = z.ZodTypeAny | OutputMap
```

### Single schema

The single-schema form is the `200` success body. This is the common case.

```ts
export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
```

### Status-to-schema map

The map form declares a body shape per status code
([ADR-0011](/adr/0011-multi-status-output-schemas)). Use it when a route answers
more than one status with a contract you want typed and validated — a success
body plus an error envelope, or a non-`200` success such as `201`:

```ts
import { ErrorBodySchema } from 'kata'

export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const result = checkout(c.get('tx'), c.get('currentUser').id)
    if (!result.ok) return c.error('conflict', 'Out of stock', { status: 409 })
    return c.json(result.order, 201)
  },
})
```

`ErrorBodySchema` is exported from `kata`. It is the Zod mirror of the unified
error envelope `c.error(...)` produces ([Errors](/guide/errors)), so it is the
canonical schema to put behind a `4xx`/`5xx` status. An app may substitute a
stricter refinement (for example a literal `error` code) for a tighter contract.

### Which status a return maps to

`SuccessOutput<O>` is the type a **plain return** must satisfy — always the
`200` body: `z.infer` of the single schema, or of `output[200]` for a map.

```ts
type SuccessOutput<O extends OutputSpec> =
  O extends z.ZodTypeAny
    ? z.infer<O>
    : O extends OutputMap
      ? 200 extends keyof O ? z.infer<O[200]> : never
      : never

type RouteHandlerReturn<O extends OutputSpec> = SuccessOutput<O> | Response
```

A map with no `200` entry makes `SuccessOutput` resolve to `never`, so the
handler is forced to return a `Response` — `checkoutRoute` above declares `201`
but not `200`, so `c.json(result.order, 201)` is the only way to answer success.
Every status other than `200` is set explicitly with `c.json(body, status)` or
`c.error(...)`.

::: tip
The map form is backward compatible at the value level: a route using a single
`output: Schema` compiles and behaves exactly as a map with only a `200` entry.
:::

## The handler context

The handler receives `c: RouteContext<R, I>`:

```ts
type RouteContext<R extends Registry, I extends InputSchemas> = {
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  input: InferInput<I>
  json<T>(value: T, status?: number): Response
  error(code: string, message: string, extra?: ErrorExtra): Response
  requestId: string
  raw: import('hono').Context
}
```

| Member       | Purpose |
|--------------|---------|
| `c.input`    | The parsed, typed request input (see above). |
| `c.get(key)` | Read a registered dependency — singleton value or scoped slot. Only type-checks for keys in `defineContext`. |
| `c.json`     | Build a JSON `Response`; `status` defaults to `200`. |
| `c.error`    | Build the unified error envelope ([ADR-0008](/adr/0008-unified-error-response-envelope)); `status` defaults to `400`. |
| `c.requestId`| The per-request correlation id, also echoed on the `x-request-id` response header. |
| `c.raw`      | The underlying Hono `Context` — an escape hatch. |

### Return a value or a `Response`

A handler returns one of two things:

- **A plain value** — validated against the success schema, then serialized as a
  `200` JSON response. Zod transforms apply.
- **A `Response`** — built with `c.json` or `c.error` to set a custom status.

```ts
export const getProductRoute = defineRoute({
  method: 'GET',
  path: '/products/:id',
  input: { params: z.object({ id: z.string() }) },
  output: ProductSchema,
  handler: (c) => {
    const product = getProduct(c.get('store'), c.input.params.id)
    if (!product) return c.error('not_found', 'Product not found', { status: 404 })
    return product // validated against ProductSchema, sent as 200
  },
})
```

### `c.get` — read dependencies

`c.get(key)` returns the resolved value of a registered slot: a singleton's
value, or a scoped slot filled by a middleware in `use` (or by app-level
middleware). Reading a scoped slot that no middleware in the chain provided
throws at runtime, so list the providing middleware in `use`.

```ts
export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser], // provides the 'currentUser' scoped slot
  input: {},
  output: UserSchema,
  handler: (c) => c.get('currentUser'),
})
```

See [Context & DI](/guide/context-di) for slot kinds and middleware wiring.

### `c.error` and `ErrorExtra`

`c.error` produces the unified error envelope and defaults to status `400`. Its
third argument sets another status and optional structured field errors:

```ts
type ErrorExtra = {
  status?: number      // HTTP status; defaults to 400
  issues?: FieldIssues // structured field errors, attached under `issues`
}
```

```ts
return c.error('not_found', 'User not found', { status: 404 })
```

## Validation behavior

Kata validates `input` **before** the handler runs and `output` **after** it
returns ([ADR-0003](/adr/0003-mandatory-input-output-schemas)). See
[Errors](/guide/errors) for the complete envelope reference.

### Input — before the handler

Every declared section is parsed with `safeParse`. If any fails, the handler
never runs and Kata responds `422` with a fixed envelope: `error:
"validation_failed"`, a `message`, and an `issues` object keyed by the failing
section (`params`, `query`, `body`, or `headers`), each an array of field
issues.

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

Each field issue is `{ path, message, code }`, with optional `expected` /
`received` for type mismatches. `path` uses dot/bracket notation for nested
fields (`address.zip`, `tags[0]`). A `body` schema with an unreadable or
non-JSON body parses against `undefined`, so the schema decides the outcome.

### Output — after the handler

A **plain return** is validated against the success schema (the single schema,
or `output[200]`). On mismatch under the default `strict` mode, Kata responds
`500 { "error": "internal_output_shape_mismatch" }` and logs the offending Zod
issues server-side — the wrong shape never reaches the client.

A returned **`Response`** carries its own status. In the **map form**, when that
status is a declared key, Kata validates a clone of the body against
`output[status]` and forwards the original `Response` unchanged on success
(headers and content type the handler set are preserved). In the
**single-schema form**, and for any status the map does not declare, a
`Response` passes through unvalidated.

::: info Output-validation mode
The `strict` behavior above is the default outside production. The mode —
`strict` (log + `500`), `log` (log + serve the data anyway), or `off` (skip
validation) — is set per app on `createApp` or via the `KATA_OUTPUT_VALIDATION`
env var; production defaults to `log`. See
[ADR-0009](/adr/0009-output-validation-mode).
:::

## See also

- [Routes & schemas](/guide/routes-schemas) — the guide walkthrough.
- [Errors](/guide/errors) — the `422` and `500` envelopes, and returning your own `4xx`.
- [`defineContext`](/reference/define-context) — where `defineRoute` and `c.get` come from.
- [`createApp`](/reference/create-app) — collecting routes into an app.
- [`defineMiddleware`](/reference/define-middleware) — filling the scoped slots `c.get` reads.
