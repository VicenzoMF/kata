---
title: Routes & schemas
description: Define a route with defineRoute — mandatory input and output Zod schemas, typed handlers, and multi-status responses.
---

# Routes & schemas

A route is a single call to `defineRoute`. It declares an HTTP method, a path,
the schemas for what enters the route, the schema for what leaves it, an
optional middleware chain, and a handler. Both `input` and `output` are
mandatory — omitting either is a TypeScript error ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

`defineRoute` comes from your context, not from a global import. `defineContext`
returns it bound to your registry, so `c.get('key')` inside the handler only
type-checks for keys you registered (see [Context & DI](/guide/context-di)).

```ts
// src/modules/echo/echo.route.ts
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

A route file contains `defineRoute` calls and nothing else. Export each route
as a named const; `createApp` collects them through a namespace import of the
`.route.ts` file.

## The `defineRoute` shape

```ts
defineRoute({
  method,   // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path,     // a Hono path string, e.g. '/users/:id'
  input,    // { params?, query?, body?, headers? } — each a Zod schema
  output,   // a single Zod schema OR a status→schema map
  use,      // optional: Middleware[] that runs before this route's handler
  handler,  // (c) => value | c.json(...) | c.error(...)
})
```

`method` and `path` are inferred as literal types and flow into the RPC client.
`use` defaults to `[]` when omitted; app-level middleware from `createApp` runs
before it (see [App middleware](/guide/app-middleware)).

## `input` — the four sections

`input` is an object with any of four keys, each a Zod schema:

```ts
type InputSchemas = {
  params?: z.ZodTypeAny
  query?: z.ZodTypeAny
  body?: z.ZodTypeAny
  headers?: z.ZodTypeAny
}
```

You declare only the sections the route reads. Each maps to a part of the
request:

| Section   | Source                          |
|-----------|---------------------------------|
| `params`  | path parameters (`/users/:id`)  |
| `query`   | URL query string                |
| `body`    | parsed JSON request body        |
| `headers` | request headers (lowercased)    |

Inside the handler, `c.input` is typed from these schemas. A section you did not
declare is `undefined` on `c.input`, so reading `c.input.query` only type-checks
when you declared a `query` schema.

```ts
// src/modules/users/users.route.ts
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = await getUser(c.input.params.id) // string, typed
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})
```

A route that reads none of the four sections still declares `input`
explicitly, as an empty object:

```ts
export const requestIdRoute = defineRoute({
  method: 'GET',
  path: '/request-id',
  input: {},
  output: RequestIdResponseSchema,
  handler: (c) => ({ requestId: c.requestId }),
})
```

::: tip
`input: {}` is not boilerplate noise — it is the contract stating "this route
reads no input". The lint rule `kata/no-route-without-input-schema` requires it
to be present and explicit.
:::

## `output` — single schema or status map

`output` is either a single Zod schema or a map from HTTP status code to schema:

```ts
type OutputMap = { readonly [status: number]: z.ZodTypeAny }
type OutputSpec = z.ZodTypeAny | OutputMap
```

### Single schema

The single-schema form describes the `200` success body. This is the common
case.

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

The map form declares a body shape per status code ([ADR-0011](/adr/0011-multi-status-output-schemas)).
Use it when a route answers more than one status with a contract you want typed
and validated — for example a `200` success body and a `404` error envelope:

```ts
import { ErrorBodySchema } from 'kata'

output: { 200: UserSchema, 404: ErrorBodySchema }
```

`ErrorBodySchema` is exported from `kata`. It is the Zod mirror of the unified
error envelope that `c.error(...)` produces ([Errors](/guide/errors)), so it is
the canonical schema to put behind a `4xx`/`5xx` status. An app may substitute a
stricter refinement (for example a literal `error` code) when it wants a tighter
contract.

::: info How the status is chosen
A **plain return** is always the `200` body — it is validated against the single
schema, or against `output[200]` for a map. Every other status is set explicitly
with `c.json(body, status)` or `c.error(...)`.

A map used with plain returns must therefore declare a `200` entry. If it does
not, the plain-return type is `never` and the handler is forced to return a
`Response` — for example a create route that only ever answers `201`.
:::

The map form is fully backward compatible at the value level: a route that uses
a single `output: Schema` compiles and behaves exactly as before.

## The handler

The handler receives the route context `c` and returns one of two things:

- **a plain value** — validated against the success schema, then serialized as a
  `200` JSON response. Zod transforms apply.
- **a `Response`** — built with `c.json(value, status?)` or
  `c.error(code, message, extra?)` to set a custom status.

```ts
json<T>(value: T, status?: number): Response
error(code: string, message: string, extra?: ErrorExtra): Response
```

`c.json` defaults to status `200`. `c.error` produces the unified error envelope
and defaults to status `400`; pass `{ status }` (and optionally `issues`) in its
third argument to set another:

```ts
type ErrorExtra = {
  status?: number      // HTTP status; defaults to 400
  issues?: FieldIssues // structured field errors, attached under `issues`
}
```

Returning a `Response` short-circuits: the body's validation depends on the
`output` form. In the map form, when the response's status is a declared key,
Kata validates a clone of the body against `output[status]` and forwards the
original `Response` unchanged on success. In the single-schema form — and for any
status the map does not declare — a `Response` passes through unvalidated. See
[ADR-0011](/adr/0011-multi-status-output-schemas) for the exact validation
semantics.

The route context also exposes `c.get(key)` for registered dependencies,
`c.requestId` (the per-request correlation id), and `c.raw` (the underlying Hono
context — an escape hatch).

## Validation, both ends

Kata validates `input` **before** the handler runs and `output` **after** it
returns ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

When input fails its schema, the handler never runs. Kata responds `422` with a
fixed envelope: `error: "validation_failed"`, a `message`, and an `issues`
object keyed by the input section that failed, each an array of field issues:

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
fields (`address.zip`, `tags[0]`).

When a **plain return** does not match its `output` schema, Kata responds
`500 { "error": "internal_output_shape_mismatch" }` and logs the offending Zod
issues server-side — the wrong shape never reaches the client. This is the
`strict` behavior (the default outside production); the
[output-validation mode](/guide/errors) governs whether a mismatch 500s, logs
and serves anyway, or is skipped.

See [Errors](/guide/errors) for the full envelope reference and how to return
your own `4xx`.

## Schemas live in `<domain>.schema.ts`

Schemas are never declared inline in a `.route.ts` file. Every domain's Zod
schemas live in `src/modules/<domain>/<domain>.schema.ts`; routes import them by
name ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)). An inline
`z.object(...)` in a route file is a lint error (`kata/inline-schema`).

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

export const GetUserParamsSchema = z.object({
  id: z.string(),
})

export type User = z.infer<typeof UserSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

```ts
// src/modules/users/users.route.ts
import { ErrorBodySchema } from 'kata'

import { defineRoute } from '../../context'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'
```

Naming conventions:

- `*Schema` for Zod schemas.
- `*` types (e.g. `User`, `CreateUserBody`) inferred via `z.infer`, declared
  next to the schema.

This keeps the User contract findable by glob (`src/modules/**/*.schema.ts`) and
by exact symbol search (`grep "UserSchema"`), and lets both the route and its
[service](/guide/services) import the same shape. The service stays a pure
function over those inferred types:

```ts
// src/modules/users/users.service.ts
import type { CreateUserBody, User } from './users.schema'

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  return user
}
```

## See also

- [Errors](/guide/errors) — the `422` and `500` envelopes, and returning your own `4xx`.
- [`defineRoute` reference](/reference/define-route) — the full signature and types.
- [Context & DI](/guide/context-di) — where `defineRoute` and `c.get` come from.
- [Services](/guide/services) — the pure functions a handler calls.
