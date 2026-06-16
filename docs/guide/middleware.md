---
title: Middleware & scoped slots
description: Define middleware, fill scoped slots, short-circuit with a Response, and compose route-level use with app-level chains.
---

# Middleware & scoped slots

Middleware is how a request is prepared before the handler runs. A middleware
authenticates the caller, opens a transaction, sets a header, or rejects the
request outright. In Kata a middleware does exactly one job for the type system:
it **fills the scoped slots** declared in `defineContext`. A handler reads those
slots with `c.get`; the slot is only sound if a middleware that fills it ran
first.

There is no separate plugin system and no decorators. A middleware is a value
produced by `defineMiddleware`, and you compose it onto a route with `use:` or
onto the whole app with `middlewares:`.

## defineMiddleware

`defineContext` returns `defineMiddleware`. Import it from your context module,
not from `kata`:

```ts
import { defineMiddleware } from '../context'
```

The shape is two fields:

```ts
defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    // ...prepare the request, fill slots, optionally short-circuit...
    await next()
  },
})
```

- `provides` is the list of **scoped** slot keys this middleware fills. Write it
  `as const` so the literal keys stay greppable and lint-checkable — the
  `kata/scoped-slot-not-provided` rule unions the `provides` of a route's chain
  to prove every `c.get('slot')` has a provider.
- `handler` receives the middleware context `c` and a `next` function. It runs
  its setup, calls `await next()` to continue down the chain, and may run code
  after `next()` returns. Returning a `Response` short-circuits (see below).

A middleware that only sets a header or rejects a request provides nothing —
declare `provides: [] as const`.

### The middleware context

`c` in a middleware handler is a `MiddlewareContext`, a smaller surface than the
route context:

| Member | Purpose |
| --- | --- |
| `c.get('key')` | Read any registered slot — a singleton, or a scoped slot already filled this request. |
| `c.set('key', value)` | Fill a **scoped** slot. Only compiles for scoped keys; throws at runtime for a singleton key. |
| `c.header('name')` | Read a request header. Returns `string \| undefined`. |
| `c.json(value, status?)` | Build a JSON `Response` (status defaults to `200`). Return it to short-circuit. |
| `c.error(code, message, extra?)` | Build the unified error envelope. Status defaults to `400`; pass `{ status }` to change it. |
| `c.requestId` | The correlation id for this request (the inbound `x-request-id` or a fresh UUID). |
| `c.raw` | The underlying Hono `Context` — an escape hatch. |

::: warning `c.header` reads, it does not write
In a middleware, `c.header(name)` is a request-header **getter**. There is no
`c.set` for response headers and no body post-processing: Kata builds its
response detached from `c.res`, so a `use`/global chain prepares the request and
may short-circuit, but cannot rewrite the final body. Response transformers
(compression, ETag) do not belong here. If you must set a response header, do it
on `c.raw` before returning, or build the `Response` yourself.
:::

## Filling a scoped slot

Scoped slots are declared once in `defineContext` and start each request empty. A
middleware fills one with `c.set`, and the handler reads it with `c.get`.

Given a context with a `currentUser` scoped slot:

```ts
import { defineContext, scoped, singleton } from 'kata'

export type CurrentUser = { id: string }

export const k = defineContext({
  store: singleton(createStore()),
  currentUser: scoped<CurrentUser>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

a minimal auth middleware reads a header, rejects when it is missing, and
otherwise fills the slot:

```ts
import { defineMiddleware } from '../context'

export const requireAuth = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const userId = c.header('x-user-id')
    if (!userId) return c.error('unauthorized', 'Missing x-user-id header', { status: 401 })

    c.set('currentUser', { id: userId })
    await next()
  },
})
```

This is the `examples/shop` toy auth verbatim — a placeholder for real token or
session decoding. The handler downstream never sees an unauthenticated request:
either the slot is filled and `next()` runs, or the middleware short-circuits
with a 401 and the handler is skipped.

::: tip A scoped read needs a provider
`c.get('currentUser')` is only valid in handlers reached through a chain that
provides it. Reading a scoped slot whose providing middleware did not run throws
at runtime (`scoped slot 'currentUser' read before being set`) and is flagged by
the `kata/scoped-slot-not-provided` lint rule. Singletons need no provider —
they live for the process lifetime.
:::

For real authentication, `kata/jwt` ships `jwtAuth`, which verifies a bearer
token and fills a `currentUser` slot for you. The example app wraps it so the
`provides` literal stays at the call site:

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

See [JWT auth](/guide/jwt) for the full `jwtAuth` contract and the role/claim
guards.

## Short-circuit by returning a Response

A middleware handler's return type is `Promise<void | Response> | void | Response`.
Return `void` (or just call `await next()`) to continue. **Return a `Response` to
stop the request immediately** — every later middleware, the input validation,
and the handler are all skipped.

Build that `Response` with `c.error(...)` or `c.json(...)`:

```ts
handler: async (c, next) => {
  const token = c.header('authorization')
  if (!token) return c.error('unauthorized', 'Missing Authorization header', { status: 401 })
  // ...verify, fill slot...
  await next()
}
```

A short-circuit response still flows through the rest of the pipeline's
bookkeeping: it gets the `x-request-id` header and is logged like any other
outcome. Because of this, a 401 raised by a middleware is **not** part of the
route's `output` contract — it never reaches the handler, so you do not declare
it in `output:`. Only statuses your handler itself returns belong there.

Throwing also stops the request, but as an unhandled error: it is logged
server-side and funnelled into the unified `500 internal_error` envelope. Use
`return c.error(...)` for an expected rejection (auth failure, forbidden); let a
throw signal a genuine bug. See [Errors](/guide/errors).

## Composing middleware onto a route

A route lists its middleware in `use:`, in order. The chain runs left to right
before the handler:

```ts
import { ErrorBodySchema } from 'kata'

import { defineRoute } from '../../context'
import { requireAuth } from '../../middlewares/auth'
import { withTransaction } from '../../middlewares/transaction'
import { OrderSchema } from './orders.schema'
import { checkout } from './orders.service'

export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx') // provided by withTransaction
    const user = c.get('currentUser') // provided by requireAuth
    const result = checkout(tx, user.id)
    // ...commit on success, or c.error(...) to roll back...
    return c.json(result.order, 201)
  },
})
```

`use: [requireAuth, withTransaction]` means `requireAuth` runs first and
`withTransaction` second, so by the time the handler runs both `currentUser` and
`tx` are filled. Declared array order is the contract — if one slot depends on
another (a `tenantId` derived from `currentUser`), put the provider earlier.

The same middleware instance composes onto as many routes as you like; there is
no per-route duplication. `requireAuth` above guards checkout, the order list,
and a single-order lookup from one definition.

## App-level middleware

A concern that applies to every route — CORS, secure headers, a body-size limit
— does not belong in each route's `use:`. Declare it once on the app with
`createApp({ middlewares })`:

```ts
import { bodyLimit, cors, secureHeaders } from 'kata'

import { createApp } from './context'
import * as orders from './modules/orders/orders.route'
import * as products from './modules/products/products.route'

export const app = createApp({
  modules: [products, orders],
  middlewares: [secureHeaders(), cors(), bodyLimit()], // run before every route's use:
})
```

The app-level chain runs **before** each route's own `use:`. The effective chain
for any route is:

```ts
effective = [...config.middlewares, ...route.use]
```

It is the same `Middleware<R>` contract, the same runtime pipeline, and the same
per-request scoped store. A global middleware may short-circuit with a `Response`
exactly as a route middleware does, and a scoped slot it `provides:` is readable
via `c.get` in **every** handler — a global `requireAuth` makes `currentUser`
available app-wide without any route listing it in `use:`.

Reach for `use:` when a concern is specific to a route or a few routes, and for
`middlewares:` when it is genuinely cross-cutting. See
[App-level middleware](/guide/app-middleware) for the ordering rules and the
trade-off against ADR-0004's explicit per-route dependency trace.

## Worked example: a transaction slot

The `examples/shop` app provides a per-request unit of work as a scoped slot.
The middleware opens a transaction from the `store` singleton, fills the `tx`
slot, and — critically — **rolls back on any path that did not commit**:

```ts
import { defineMiddleware } from '../context'

export const withTransaction = defineMiddleware({
  provides: ['tx'] as const,
  handler: async (c, next) => {
    const tx = c.get('store').begin()
    c.set('tx', tx)
    try {
      await next()
    } catch (err) {
      tx.rollback()
      throw err
    }
    // Reached only when the handler returned without committing (e.g. it
    // short-circuited with c.error). rollback() is a no-op once committed.
    if (tx.status === 'open') tx.rollback()
  },
})
```

This is the canonical shape of a slot-providing middleware that also owns cleanup:

1. **Open** the resource from a singleton (`c.get('store').begin()`).
2. **Fill** the scoped slot (`c.set('tx', tx)`) so the handler can stage work on it.
3. **Run** the rest of the chain inside `try { await next() }`.
4. **Roll back on a throw**, then rethrow so the error still reaches the 5xx
   boundary.
5. **Roll back after `next()`** if the handler never committed — an early
   `c.error(...)` short-circuit returns control here with the transaction still
   `open`.

The handler reads the slot, stages its writes, and commits explicitly on
success; anything else leaves the transaction un-committed and the middleware
discards the staged work, so a partial write never reaches the store. The
slot's type comes from `defineContext` (`tx: scoped<Transaction>()`), so
`c.get('tx')` is fully typed in the handler.

## See also

- [Context & DI](/guide/context-di) — declaring singletons and scoped slots.
- [Routes & schemas](/guide/routes-schemas) — `defineRoute`, `use:`, and the `output` contract.
- [App-level middleware](/guide/app-middleware) — the global chain in depth.
- [JWT auth](/guide/jwt) — `jwtAuth`, guards, and the `currentUser` slot.
- [Errors](/guide/errors) — the unified envelope `c.error` builds.
