---
title: Quickstart
description: Build a fully-typed /users API in six files, boot it, and call it — including validation failures and the JWT-protected /me route.
---

# Quickstart

A fully-typed `/users` API in six files. This is exactly
[`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello).
Read it top to bottom, then boot it and call it.

## Install

Kata has two peer dependencies — Hono (the HTTP base) and Zod (schemas) — plus
Hono's Node adapter to boot a server on Node.

```bash
npm install kata hono zod @hono/node-server
# or: pnpm add kata hono zod @hono/node-server
```

::: warning Pre-release
Kata is not yet published to npm. Today the fastest path is to clone the repo
and run the worked example, which is what the rest of this page walks through.

```bash
git clone https://github.com/VicenzoMF/kata.git
cd kata && pnpm install
pnpm --filter=hello dev      # boots examples/hello on http://localhost:3000
```
:::

## The six files

Kata locks the folder layout so every route, service, schema, and test is
findable by glob (see [project layout](/guide/project-layout)). The example
folds `app.ts` into `main.ts`, leaving six files:

```
examples/hello/src/
├── context.ts                       # defineContext({ ... })
├── middlewares/
│   └── auth.ts                       # jwtAuth → fills the currentUser slot
└── modules/users/
    ├── users.schema.ts               # Zod DTOs
    ├── users.service.ts              # pure functions
    └── users.route.ts                # defineRoute calls only
main.ts                               # createApp + serve
```

### 1. Declare every dependency once — `context.ts`

`defineContext` is the single place dependencies are registered. There are two
kinds of slot:

- `singleton(value)` — lives for the process lifetime (db pool, logger, mailer).
- `scoped<T>()` — one value per request, filled by a middleware (current user,
  tenant id, request id).

`defineContext` returns `defineRoute`, `defineMiddleware`, and `createApp`
already bound to your registry. Re-export them so the rest of the app inherits
the types — `c.get('key')` only type-checks for keys you registered here.

```ts
import { defineContext, scoped, singleton } from 'kata'

import type { User } from './modules/users/users.schema'

type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[hello] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  logger: singleton(logger),
  currentUser: scoped<User>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

See [context & DI](/guide/context-di) for the full slot model.

### 2. Schemas (DTOs) — `modules/users/users.schema.ts`

Every domain's Zod schemas live in `<domain>.schema.ts`, never inline in the
route. Export the `z.infer` types alongside them, so a single import pulls both
the runtime schema and the compile-time type.

```ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
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
export type UserClaims = z.infer<typeof UserClaimsSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

### 3. Business logic — `modules/users/users.service.ts`

Services are plain, pure functions — trivial to unit-test, no framework
imports. The in-memory `Map` here stands in for a real store.

```ts
import type { CreateUserBody, User } from './users.schema'

const store = new Map<string, User>()

export async function getUser(id: string): Promise<User | null> {
  return store.get(id) ?? null
}

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  store.set(id, user)
  return user
}
```

More on the boundary in [services](/guide/services).

### 4. Middleware & scoped slots — `middlewares/auth.ts`

A middleware declares which scoped slots it `provides`; its handler fills them.
Returning a `Response` short-circuits the request before the handler runs.

Kata ships JWT auth under `kata/jwt`. `jwtAuth` reads an `Authorization: Bearer`
token, verifies the signature and time claims, parses the payload with your Zod
schema, and fills the slot. The `resolve()` hook maps the validated claims onto
the app's `User`. Keep the `defineMiddleware` wrapper so the `provides` literal
stays greppable and lint-checkable.

```ts
import { jwtAuth } from 'kata/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

`JWT_SECRET` lives in a small `config.ts` and is shared with the token-minting
route below — they must agree or every token fails verification:

```ts
export const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret'
export const TOKEN_TTL_SECONDS = 60 * 60
```

::: warning
`dev-secret` keeps the example zero-config. A real app sets `JWT_SECRET` from
the environment and refuses to boot in production when it is unset. Never ship
`dev-secret`.
:::

To fill a slot with `c.set` directly, or to layer authorization with
`requireRole` / `guard`, see [middleware](/guide/middleware) and the
[auth cookbook](/cookbook/auth).

### 5. Routes — `modules/users/users.route.ts`

Every route declares mandatory `input` and `output` schemas — omitting either is
a TypeScript error. Inside the handler, `c.input` is fully typed from the input
schemas. A handler may either **return a value** (validated against `output`,
then serialized) or **return `c.json(...)` / `c.error(...)`** to set a custom
status.

`output` may be a single schema (the 200 body) or a status→schema map —
`{ 200: UserSchema, 404: ErrorBodySchema }` — that types and validates each
status. `ErrorBodySchema` is Kata's unified error envelope, the canonical thing
to put behind a 4xx/5xx status. Routes that read a scoped slot list the
providing middleware in `use:`.

```ts
import { ErrorBodySchema } from 'kata'

import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'

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

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
```

`c.get('currentUser')` in `meRoute` type-checks only because `requireUser`
provides that slot and is listed in `use:`. Full reference in
[routes & schemas](/guide/routes-schemas).

### 6. Boot it — `main.ts`

`createApp({ modules })` wires every exported route in each module into a Hono
app. A module is just the namespace import of a `.route.ts` file. Hand
`app.fetch` to `@hono/node-server` to listen.

Cross-cutting middleware goes in the optional `middlewares` slot — a chain that
runs **before** every route's own `use:`. The first-party hardening built-ins
(`cors()`, `secureHeaders()`, `bodyLimit()`) are the canonical case: declare
them once and every route is covered.

```ts
import { serve } from '@hono/node-server'
import { bodyLimit, cors, secureHeaders } from 'kata'

import { createApp, k } from './context'
import * as auth from './modules/auth/auth.route'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users, auth],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

::: tip
The example also passes `requestLogging: true` and an explicit
`outputValidation` knob. Both are optional. See [app middleware](/guide/app-middleware)
and [lifecycle](/guide/lifecycle).
:::

The token-minting route imported above (`modules/auth/auth.route.ts`) signs a
JWT with `signJwt` so you can exercise `/me` without external tooling. It trusts
its caller and is **not** how you authenticate real users:

```ts
import { signJwt } from 'kata/jwt'

import { JWT_SECRET, TOKEN_TTL_SECONDS } from '../../config'
import { defineRoute } from '../../context'

import { TokenRequestSchema, TokenResponseSchema } from './auth.schema'

export const mintTokenRoute = defineRoute({
  method: 'POST',
  path: '/auth/token',
  input: { body: TokenRequestSchema },
  output: TokenResponseSchema,
  handler: async (c) => {
    const { id, name, email } = c.input.body
    const token = await signJwt(
      { name, email },
      { secret: JWT_SECRET, subject: id, expiresInSeconds: TOKEN_TTL_SECONDS },
    )
    return { token }
  },
})
```

The real seam for login, password hashing, and refresh is yours — see the
[JWT guide](/guide/jwt) and [auth cookbook](/cookbook/auth).

## Run it

From the cloned repo, the example is wired with [`tsx`](https://tsx.is):

```bash
pnpm --filter=hello dev      # tsx watch src/main.ts → http://localhost:3000
```

In a standalone project, add `tsx` (`npm i -D tsx`) and run `tsx watch src/main.ts`.

## Call it

Create a user, then fetch it back:

```bash
# Create a user (valid body) → 200, validated against UserSchema
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com"}'
# {"id":"f81d4fae-…","name":"Ada","email":"ada@example.com"}

# Fetch it back by id → 200
curl -s localhost:3000/users/f81d4fae-…

# Unknown id → 404, the unified error envelope from c.error
curl -s localhost:3000/users/none
# {"error":"not_found","message":"User not found"}
```

### Validation fails before your handler

Kata validates `input` **before** the handler runs. On failure it responds
`422` with a normalised envelope: `error: "validation_failed"` plus `issues`
keyed by the input section that failed (`params`, `query`, `body`, or
`headers`).

```bash
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"name":"","email":"not-an-email"}'
```

```json
{
  "error": "validation_failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "String must contain at least 1 character(s)" },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Each field issue is `{ path, message, code }`, with optional `expected` /
`received` for type mismatches. Output is validated too, **after** the handler
returns: a value that does not match its `output` schema yields
`500 {"error":"internal_output_shape_mismatch"}` and is logged server-side — the
wrong shape never reaches the client. Full treatment in [errors](/guide/errors).

### The JWT-protected `/me` flow

Mint a token, then call `/me` with it:

```bash
# Mint a token for an identity (stand-in for a real login)
curl -s localhost:3000/auth/token \
  -H 'content-type: application/json' \
  -d '{"id":"42","name":"Ada","email":"ada@example.com"}'
# {"token":"eyJhbGc…"}

# No token → 401, the unified envelope
curl -s localhost:3000/me
# {"error":"unauthorized","message":"Missing bearer token"}

# With the token → 200, the resolved currentUser
curl -s localhost:3000/me -H 'Authorization: Bearer eyJhbGc…'
# {"id":"42","name":"Ada","email":"ada@example.com"}
```

`requireUser` verifies the token, parses the claims with `UserClaimsSchema`,
and `resolve()` reshapes them into the `currentUser` slot that `meRoute` reads.

## Where to next

- [Context & DI](/guide/context-di) — singletons, scoped slots, and the registry.
- [Routes & schemas](/guide/routes-schemas) — input/output contracts in depth.
- [Middleware](/guide/middleware) and [app middleware](/guide/app-middleware) — slot-filling and the global chain.
- [Errors](/guide/errors) — the 422/500 envelopes and `c.error`.
- [JWT](/guide/jwt) — real auth, guards, and the `resolve()` hook.
- [RPC client](/guide/rpc-client) — `hc<AppType>` for end-to-end typed calls, no codegen.
- [Project layout](/guide/project-layout) — the locked folder structure.
