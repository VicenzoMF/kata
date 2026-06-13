# Recipe: Authentication

**Problem:** identify the caller, reject unauthenticated requests, and make the
authenticated user available to every handler that needs it — without a global
variable and without threading the user through every function signature.

**Pattern:** a middleware that **provides a scoped slot**. This is exactly the
shape [ADR-0004](../adr/0004-di-via-scoped-slots.md) calls _Pattern C_: scoped
slots are declared up front in `defineContext`, and a middleware populates them
per request. A handler reads the user with `c.get('currentUser')` — the same
monomorphic accessor used for singletons.

The reference app already ships a minimal version in
[`examples/hello/src/middlewares/auth.ts`](../../examples/hello/src/middlewares/auth.ts);
this recipe builds it out.

## 1. Declare the scoped slot

Scoped slots live in `defineContext` alongside singletons. `scoped<T>()` takes no
value — it only declares the type that a middleware will later `set`.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'kata'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

export const k = defineContext({
  db: singleton(makeDb(process.env)),
  currentUser: scoped<User>(), // ← one User per request
})

export const { defineRoute, defineMiddleware, createApp } = k
```

## 2. Write the auth middleware

`defineMiddleware` takes a `provides` array — the scoped slots this middleware
populates — and a handler that receives the middleware context `c` and `next`.

The middleware context exposes `c.header(name)` to read a request header,
`c.set(key, value)` to fill a scoped slot, and `c.json(body, status)` to
short-circuit the request. Returning a `Response` (instead of calling `next()`)
stops the chain — the route handler never runs.

```ts
// src/middlewares/auth.ts
import { defineMiddleware } from '../context'

import { verifyToken } from './token' // your JWT/session verifier → User | null

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const header = c.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    if (!token) return c.error('unauthorized', 'Missing bearer token', { status: 401 })

    const user = await verifyToken(token)
    if (!user) return c.error('unauthorized', 'Invalid or expired token', { status: 401 })

    c.set('currentUser', user)
    await next()
  },
})
```

> `verifyToken` is your code, not framework API — swap in your real JWT or
> session logic. Keep its return type concrete (`Promise<User | null>`); `any` is
> banned, so narrow `unknown` payloads with a Zod schema before trusting them.

`provides: ['currentUser'] as const` is load-bearing: the `as const` keeps the
literal key types so the type system and the `kata/middleware-provides-mismatch`
lint rule can check that a middleware actually `set`s everything it claims to
provide.

## 3. Consume it in a route

A route opts into the middleware via `use: [...]`. Order matters — middlewares
run left to right. Once `requireUser` has run, `c.get('currentUser')` returns a
`User` synchronously inside the handler.

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

import { UserSchema } from './users.schema'

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
```

Returning the user value (not a `Response`) means Kata validates it against
`output` (`UserSchema`) before sending it — see [errors.md](./errors.md).

## Behaviour over the wire

This mirrors the `GET /me` cases asserted in
[`users.hurl`](../../examples/hello/src/modules/users/users.hurl):

```http
GET /me
→ 401  { "error": "unauthorized", "message": "Missing bearer token" }

GET /me
Authorization: Bearer <valid-token>
→ 200  { "id": "...", "name": "...", "email": "..." }
```

## Authorization: a role guard that depends on the user

A second middleware can _read_ a scoped slot it doesn't provide, as long as a
middleware earlier in the `use:` chain provided it. Its `provides` list is empty.
This is the recommended way to layer authorization on top of authentication —
the **order in the `use:` array is the contract**
([#23](https://github.com/VicenzoMF/kata/issues/23) tracks formalising
dependent-slot ordering).

```ts
// src/middlewares/require-role.ts
import { defineMiddleware } from '../context'

export const requireAdmin = defineMiddleware({
  provides: [] as const, // reads currentUser, provides nothing
  handler: async (c, next) => {
    const user = c.get('currentUser') // requires requireUser to run first
    if (user.role !== 'admin') return c.error('forbidden', 'Admin role required', { status: 403 })
    await next()
  },
})
```

```ts
// in a route — requireUser MUST come before requireAdmin
use: [requireUser, requireAdmin]
```

> This assumes `User` carries a `role` field; extend `UserSchema` in
> `users.schema.ts` accordingly. For guards parameterised by role, export a
> factory `requireRole(role: string)` that returns a `defineMiddleware({...})`.

## Composing dependent slots in one middleware

If one slot is derived from another (e.g. `tenantId` from the user), a single
middleware can provide both — it sets them in order:

```ts
// context.ts:  tenantId: scoped<string>()
export const requireUser = defineMiddleware({
  provides: ['currentUser', 'tenantId'] as const,
  handler: async (c, next) => {
    const user = await verifyToken(/* ... */)
    if (!user) return c.error('unauthorized', 'Invalid or expired token', { status: 401 })
    c.set('currentUser', user)
    c.set('tenantId', user.tenantId)
    await next()
  },
})
```

## Why scoped instead of a module-level variable

- **Per-request isolation.** A module global would leak one request's user into
  the next under concurrency. A scoped slot is stored per request.
- **Statically verifiable.** Because every read is `c.get('currentUser')` and
  every provider declares `provides: ['currentUser']`, the harness can prove that
  no route reads `currentUser` without an auth middleware in its chain — the
  `kata/scoped-slot-not-provided` rule (ADR-0004, _Companion rules_).
- **Explicit failure.** An auth middleware that fails short-circuits with a
  `Response`; it cannot fall through and leave the slot unset.

## Gotchas

- **Reading a scoped slot with no provider throws at runtime.** If a handler
  calls `c.get('currentUser')` but no middleware in `use:` set it, Kata throws
  `kata: scoped slot 'currentUser' read before being set. Did the providing
  middleware run?`. The `kata/scoped-slot-not-provided` lint rule turns this into
  a build-time error.
- **`c.set` and `c.header` are middleware-only.** The route handler context has
  `c.get`, `c.input`, `c.json`, `c.error`, and `c.raw` — but no `set` (handlers
  consume slots, they don't fill them) and no `header` shortcut (read headers via
  an `input.headers` schema, or `c.raw.req.header(...)`).
- **Don't read scoped slots at module load.** They only exist inside a request
  (planned `kata/scoped-read-outside-request` rule).
