---
title: Routes & schemas
description: Define a route with defineRoute — mandatory input and output Zod schemas, typed handlers, multi-status responses, and non-JSON bodies with raw().
---

# Routes & schemas

A route is a single call to `defineRoute`. In that one call you declare everything
the framework needs to know about one endpoint: its HTTP method and path, the shape
of what comes *in*, the shape of what goes *out*, an optional middleware chain, and
the handler that does the work.

The headline rule is that **both `input` and `output` are mandatory** — leave either
out and it is a TypeScript error, not something you discover in production
([ADR-0003](/adr/0003-mandatory-input-output-schemas)). The reason is that a route's
contract — what it accepts and what it returns — should never be implicit. It is
written down, type-checked, and (as you will see) enforced at runtime on both ends.

`defineRoute` comes from *your context*, not from a global import. `defineContext`
returns it already bound to your registry (see [Context & DI](/guide/context-di)),
which is what lets `c.get('key')` inside the handler type-check against the exact
slots you declared.

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

A route file holds `defineRoute` calls and nothing else. Export each route as a
named const; `createApp` later collects them by importing the whole `.route.ts`
file as a namespace, so every route you export is picked up automatically.

## The `defineRoute` shape

Here is the full object, with the job of each field:

```ts
defineRoute({
  method,   // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path,     // a Hono path string, e.g. '/users/:id'
  input,    // { params?, query?, body?, headers? } — each a Zod schema
  output,   // a single entry (Zod schema or raw()) OR a status→entry map
  use,      // optional: Middleware[] that runs before this route's handler
  handler,  // (c) => value | c.json(...) | c.error(...)
})
```

`method` and `path` are not just strings to the type system — they are inferred as
*literal* types and flow all the way into the RPC client, so a caller knows this is
a `POST /echo` and nothing else. `use` defaults to `[]` when you omit it; any
app-level middleware registered on `createApp` runs *before* this route's own `use:`
chain (see [App middleware](/guide/app-middleware)).

## `input` — the four sections

An HTTP request does not arrive as one blob. Its data lives in four different
places, and `input` mirrors exactly those four. You provide a Zod schema for each
section the route actually reads:

```ts
type InputSchemas = {
  params?: z.ZodTypeAny
  query?: z.ZodTypeAny
  body?: z.ZodTypeAny
  headers?: z.ZodTypeAny
}
```

| Section   | Where it comes from             |
|-----------|---------------------------------|
| `params`  | path parameters (`/users/:id`)  |
| `query`   | the URL query string            |
| `body`    | the parsed JSON request body    |
| `headers` | request headers (lowercased)    |

::: warning Header keys are lowercased
HTTP header names are case-insensitive, so Kata lowercases every incoming header
key before validation. Your `headers` schema must therefore key its fields in
lowercase — `z.object({ authorization: z.string() })`, never `Authorization`. A
schema keyed on `Authorization` never matches, and the request fails validation
with a `422`.
:::

Declaring a section does two jobs at once. At runtime, Kata validates that part of
the request against your schema *before the handler runs*. At compile time, it types
the matching field on `c.input` — so inside the handler `c.input.params.id` is a
known `string`, not `any`. A section you did not declare is typed `undefined` on
`c.input`, so reading `c.input.query` only type-checks when you actually declared a
`query` schema. One schema is the single source of both the runtime check and the
static type; they cannot drift apart.

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

A route that reads *none* of the four sections still declares `input` — as an empty
object:

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
`input: {}` is not boilerplate noise — it is the contract stating, out loud, "this
route reads no input." The lint rule `kata/no-route-without-input-schema` requires
it to be present and explicit, so "I forgot to think about input" and "this route
genuinely has none" can never look the same in the source.
:::

(`c.input` here is the validated input bag, and `c.requestId` is a per-request
correlation id — both hang off the same context object `c` introduced in
[Context & DI](/guide/context-di).)

## `output` — single entry or status map

`output` describes what the route is allowed to send back. Each entry is either a
Zod schema (a JSON body) or `raw(contentType, schema)` (a non-JSON body — see
[Non-JSON responses](#non-json-responses-raw) below), and `output` itself is either
one entry or a map from status code to entry:

```ts
type OutputEntry = z.ZodTypeAny | RawOutput
type OutputMap = { readonly [status: number]: OutputEntry }
type OutputSpec = OutputEntry | OutputMap
```

### Single entry

The single-entry form describes the `200` success body — the common case, for a
route with one happy-path shape:

```ts
export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
```

A route declared this way answers with **only** that `200` body: the handler
returns the plain value, Kata validates and serialises it, and that is the whole
contract. There is no escape hatch to a `Response` here — see
[Validating a `Response`](#validating-a-response) below for why, and reach for the
map form the moment you need another status.

### Status-to-schema map

Reach for the map form when a route answers with more than one status and you want
*each* of them typed and validated — say a `200` success body and a `404` error
envelope ([ADR-0011](/adr/0011-multi-status-output-schemas)):

```ts
import { ErrorBodySchema } from 'katajs'

output: { 200: UserSchema, 404: ErrorBodySchema }
```

`ErrorBodySchema` is exported from `katajs`. It is the Zod mirror of the unified error
envelope that `c.error(...)` produces (see [Errors](/guide/errors)), which makes it
the canonical schema to put behind any `4xx`/`5xx` status. When you want a tighter
contract, substitute a stricter refinement — for example pinning `error` to a
literal code.

::: info How Kata picks which status to validate against
This is the rule that ties a return value to a status code:

- A **plain return** is *always* the `200` body. Kata validates it against the
  single entry, or against `output[200]` in a map.
- Every **other status** is one you set explicitly, with `c.json(body, status)` or
  `c.error(...)`.

So a map you return plain values from *must* include a `200` entry. If it does not,
the plain-return type collapses to `never`, and TypeScript forces you to return a
`Response` instead — which is exactly right for, say, a create route that only ever
answers `201`.
:::

A single-entry route (`output: UserSchema`) behaves exactly like a map with just a
`200` key (`output: { 200: UserSchema }`) — the two forms are read through the same
lookup, so there is nothing to relearn moving between them. Reach for the map form
the moment a route needs a second status.

## The handler

The handler is the function that runs the request. It receives the context `c` and
returns one of two things — and which one you return decides how Kata builds the
response:

- **A plain value** — the success path. Kata validates it against the success
  schema, applies any Zod transforms, and serialises it as a `200` JSON response.
  This is the case you will write most often.
- **A `Response`** — for any status other than a plain `200`, or for a
  [non-JSON body](#non-json-responses-raw). You build it with `c.json(value,
  status?)` or `c.error(code, message, extra?)`.

```ts
json<T>(value: T, status?: number): Response
error(code: string, message: string, extra?: ErrorExtra): Response
```

`c.json` defaults to status `200`. `c.error` produces the unified error envelope and
defaults to status `400`; its third argument sets anything else:

```ts
type ErrorExtra = {
  status?: number      // HTTP status; defaults to 400
  issues?: FieldIssues // structured field errors, attached under `issues`
}
```

(`c.json` and `c.error` are the response builders on `c`; the envelope `c.error`
emits is documented in full under [Errors](/guide/errors).)

### Validating a `Response`

A route only accepts a `Response` return for a status its `output` declares — a
single entry declares just `200` (equivalent to `{ 200: entry }`), a map declares
whatever keys it lists (ADR-0022). For a **declared** status, Kata validates a
*clone* of the body against that entry before forwarding your original `Response`
unchanged — a JSON schema reads it as JSON, a `raw()` entry reads it as text (see
below). For an **undeclared** status — any status a map doesn't list — the
`Response` passes through unvalidated; that's how `c.error` from an auth middleware,
or a redirect, reaches the client with no entry describing it.

This is why a single-entry route has no bare-`Response` escape hatch: every status
that route can answer with is `200`, and `200` *is* declared, so a `Response` at
`200` is always checked. A route that wants `c.error`/`c.json(body, status)` for a
second status declares that status in the map form — the same migration
[ADR-0011](/adr/0011-multi-status-output-schemas) already established:

```ts
// Won't compile: output is a bare schema, so only the plain value satisfies it.
output: UserSchema
handler: (c) => c.error('not_found', 'User not found', { status: 404 })

// Declare the status the Response actually carries:
output: { 200: UserSchema, 404: ErrorBodySchema }
handler: (c) => c.error('not_found', 'User not found', { status: 404 })
```

See [ADR-0011](/adr/0011-multi-status-output-schemas) for the full status-map
semantics.

## Non-JSON responses: `raw()`

Every example so far answers with JSON. A route that serves something else — a CSV
export, a plain-text file, a download — builds a `Response` itself, since a plain
return only ever produces JSON. Declare that contract with `raw()` instead of a Zod
schema:

```ts
import { raw } from 'katajs'

export const usersCsvRoute = defineRoute({
  method: 'GET',
  path: '/users.csv',
  input: {},
  output: raw('text/csv', UsersCsvSchema), // UsersCsvSchema = z.string()
  handler: async () => {
    const users = await listUsers()
    return new Response(usersToCsv(users), { headers: { 'content-type': 'text/csv' } })
  },
})
```

`raw(contentType, schema)` declares two things: the response's `content-type`, and
a schema for its **text** body (not JSON — `schema.safeParse` runs against the raw
string). Only a `Response` can satisfy a `raw` entry — there is no plain-value
equivalent — so `RouteHandlerReturn` makes returning anything else a `tsc` error.

At runtime, Kata checks the declared status the same way it checks a JSON entry
([Validating a `Response`](#validating-a-response) above), with one difference in
what gets checked when:

- The **`content-type` header** is always compared against the declared one
  (ignoring parameters like `; charset=utf-8`) whenever
  [output validation](/guide/errors) is not `off` — cheap, just a header read.
- The **text body** is compared against `schema` only in `strict` mode. Checking it
  needs `response.clone().text()`, which buffers the whole body into memory — fine
  for a small dev/CI response, not something Kata will do to a large download in
  `log` (the production default). A route with a `raw()` entry logs one warning at
  startup when the resolved mode means its body will go unvalidated, so that
  trade-off is never silent.

Either way, a mismatch follows the same [output-validation mode](/guide/errors) as
a JSON mismatch: `strict` replaces the response with the `500
internal_output_shape_mismatch` envelope, `log` records it and serves the original
response anyway, `off` skips both checks entirely.

`raw()` also fixes the RPC client: `hc<typeof app>` reads `outputFormat` from the
declared entry, so a `raw()` endpoint's client response exposes a typed `.text()`
instead of `.json()` — calling `.json()` on it is a type error, not a runtime
surprise.

Beyond the response builders, the context hands the handler `c.get(key)` for your
registered dependencies (see [Context & DI](/guide/context-di)), `c.requestId` for
the correlation id, and `c.raw` — the underlying Hono context, an escape hatch for
the rare thing Kata does not wrap.

## Validation, both ends

Put the two halves together and you get Kata's core promise: a route is checked on
the way in *and* on the way out
([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

**On the way in.** If the request fails its `input` schema, the handler never runs.
Kata responds `422` with a fixed envelope: `error: "validation_failed"`, a
`message`, and an `issues` object keyed by the section that failed, each holding an
array of field issues:

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

Each field issue is `{ path, message, code }`, with optional `expected` / `received`
for type mismatches. `path` uses dot/bracket notation for nested fields
(`address.zip`, `tags[0]`), so a client can map an error straight back to the field
that caused it.

**On the way out.** If a *plain return* does not match its `output` schema, Kata
responds `500 { "error": "internal_output_shape_mismatch" }` and logs the offending
Zod issues server-side — the wrong shape never reaches the client. That is the
`strict` behaviour (the default outside production); the
[output-validation mode](/guide/errors) decides whether a mismatch 500s, logs and
serves anyway, or is skipped entirely.

See [Errors](/guide/errors) for the full envelope reference and how to return your
own `4xx`.

## Schemas live in `<domain>.schema.ts`

One layout rule surfaces here: schemas are **never** declared inline in a `.route.ts`
file. Every domain's Zod schemas live in `src/modules/<domain>/<domain>.schema.ts`,
and routes import them by name ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).
An inline `z.object(...)` in a route file is a lint error (`kata/inline-schema`).

This is not tidiness for its own sake. Pulling schemas into their own file is what
lets a route *and* its [service](/guide/services) share the exact same type, and it
keeps every DTO findable two ways: by glob (`src/modules/**/*.schema.ts`) and by
exact symbol (`grep "UserSchema"`).

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
import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'
```

Two naming conventions keep this consistent:

- `*Schema` for the Zod schemas themselves.
- A matching `*` type (e.g. `User`, `CreateUserBody`) inferred with `z.infer`,
  declared right next to its schema.

Because the type is inferred *from* the schema, the two can never drift apart — and
the [service](/guide/services) stays a pure function over those inferred types, with
no framework imports:

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
