---
title: Middleware & scoped slots
description: Define middleware, fill scoped slots, short-circuit with a Response, and compose route-level use with app-level chains.
---

# Middleware & scoped slots

Middleware is the code that runs *around* a handler — preparing the request before
it, and sometimes stopping it before it ever reaches the handler. Authenticating the
caller, opening a transaction, setting a header, rejecting a bad request: all of that
is middleware.

A useful picture: each request passes through a stack of middleware on its way *in*
to the handler and back *out* to the client — like the layers of an onion. Every
layer can do work on the way in, hand off to the next layer, and do more work on the
way out. The handler sits at the core.

In Kata a middleware has one job the type system actually tracks: it **fills the
scoped slots** declared in `defineContext`. A handler reads those slots with `c.get`,
and a slot is only sound if a middleware that fills it ran first — which is exactly
why "what provides this slot?" is a question Kata can answer mechanically.

There is no separate plugin system and no decorators. A middleware is just a value
produced by `defineMiddleware`, and you compose it onto a single route with `use:` or
onto the whole app with `middlewares:`.

## defineMiddleware

`defineContext` returns `defineMiddleware` already bound to your slots. Import it from
your context module, not from `katajs`:

```ts
import { defineMiddleware } from '../context'
```

It takes an object with two fields:

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
  `kata/scoped-slot-not-provided` rule unions the `provides` of a route's chain to
  prove every `c.get('slot')` has a provider.
- `handler` is where the work happens. It receives the middleware context `c` and a
  `next` function.

That `next` is the heart of the onion model. Calling `await next()` runs *the rest of
the chain* — the later middleware and, eventually, the handler — and returns only
once they have all finished. So a handler body has up to two phases:

```ts
handler: async (c, next) => {
  // 1. on the way IN — runs before the handler
  await next()
  // 2. on the way OUT — runs after the handler has produced its response
}
```

Most middleware use only phase 1: prepare the request, then `await next()`. Phase 2
is for cleanup that must happen however the handler finished — the transaction
example at the end of this page depends on it. And returning a `Response` *instead*
of calling `next()` stops the request right there (see
[Short-circuit by returning a Response](#short-circuit-by-returning-a-response)).

A middleware that only sets a header or rejects a request provides nothing — declare
`provides: [] as const`.

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
`c.set` for response headers and no body post-processing: Kata builds its response
detached from `c.res`, so a `use`/global chain prepares the request and may
short-circuit, but cannot rewrite the final body. Response transformers
(compression, ETag) do not belong here. If you must set a response header, do it on
`c.raw` before returning, or build the `Response` yourself.
:::

## Filling a scoped slot

Scoped slots are declared once in `defineContext` and start each request empty. A
middleware fills one with `c.set`, and the handler reads it back with `c.get`. (For
the lifetime story behind that — why a scoped value is per-request and thrown away at
the end — see [Context & DI](/guide/context-di).)

Given a context with a `currentUser` scoped slot:

```ts
import { defineContext, scoped, singleton } from 'katajs'

export type CurrentUser = { id: string }

export const k = defineContext({
  store: singleton(createStore()),
  currentUser: scoped<CurrentUser>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

a minimal auth middleware reads a header, rejects when it is missing, and otherwise
fills the slot:

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
session decoding. The effect is that the handler downstream *never* sees an
unauthenticated request: either the slot is filled and `next()` runs, or the
middleware short-circuits with a 401 and the handler is skipped.

::: tip A scoped read needs a provider
`c.get('currentUser')` is only valid in handlers reached through a chain that
provides it. Reading a scoped slot whose providing middleware did not run throws at
runtime (`scoped slot 'currentUser' read before being set`) and is flagged by the
`kata/scoped-slot-not-provided` lint rule. Singletons need no provider — they live
for the process lifetime.
:::

For real authentication, `katajs/jwt` ships `jwtAuth`, which verifies a bearer token
and fills a `currentUser` slot for you. The example app wraps it so the `provides`
literal stays at the call site:

```ts
import { jwtAuth } from 'katajs/jwt'

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

See [JWT auth](/guide/jwt) for the full `jwtAuth` contract and the role/claim guards.

## Short-circuit by returning a Response

"Short-circuit" means: end the request right here, without running anything further
down the chain. A middleware handler's return type is
`Promise<void | Response> | void | Response`, and that return value is the switch:

- Return `void` (or simply call `await next()`) to **continue**.
- Return a `Response` to **stop** — every later middleware, the input validation, and
  the handler are all skipped.

Build that `Response` with `c.error(...)` or `c.json(...)`:

```ts
handler: async (c, next) => {
  const token = c.header('authorization')
  if (!token) return c.error('unauthorized', 'Missing Authorization header', { status: 401 })
  // ...verify, fill slot...
  await next()
}
```

A short-circuit response still flows through the rest of the pipeline's bookkeeping:
it gets the `x-request-id` header and is logged like any other outcome. Because of
this, a 401 raised by a middleware is **not** part of the route's `output` contract —
it never reaches the handler, so you do not declare it in `output:`. Only statuses
your handler itself returns belong there.

Throwing also stops the request, but it means something different. A returned
`c.error(...)` is an *expected* rejection — auth failed, access forbidden — an outcome
you designed for. A thrown error is an *unexpected* one: Kata logs it server-side and
funnels it into the unified `500 internal_error` envelope. So use `return c.error(...)`
for rejections you anticipate, and let a `throw` signal a genuine bug. See
[Errors](/guide/errors).

## Composing middleware onto a route

A route lists its middleware in `use:`, and they run left to right, all before the
handler:

```ts
import { ErrorBodySchema } from 'katajs'

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
`withTransaction` second, so by the time the handler runs, both `currentUser` and `tx`
are filled. That array order *is* the contract: if one slot is derived from another (a
`tenantId` computed from `currentUser`), put its provider earlier in the list.

One definition composes onto as many routes as you like; there is no per-route
duplication. The single `requireAuth` above guards checkout, the order list, and a
single-order lookup all at once.

## App-level middleware

Some concerns apply to *every* route — CORS, secure headers, a body-size limit — and
repeating them in each route's `use:` would be noise. Declare them once on the app
with `createApp({ middlewares })`:

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp } from './context'
import * as orders from './modules/orders/orders.route'
import * as products from './modules/products/products.route'

export const app = createApp({
  modules: [products, orders],
  middlewares: [secureHeaders(), cors(), bodyLimit()], // run before every route's use:
})
```

The app-level chain runs **before** each route's own `use:`. So the effective chain
for any route is just the two concatenated:

```ts
effective = [...config.middlewares, ...route.use]
```

It is the same `Middleware<R>` contract, the same runtime pipeline, and the same
per-request scoped store throughout. A global middleware may short-circuit with a
`Response` exactly as a route middleware does, and any scoped slot it `provides:`
becomes readable via `c.get` in **every** handler — a global `requireAuth` makes
`currentUser` available app-wide without a single route listing it in `use:`.

The rule of thumb: reach for `use:` when a concern is specific to a route or a few
routes, and for `middlewares:` when it is genuinely cross-cutting. See
[App-level middleware](/guide/app-middleware) for the ordering rules and the trade-off
against ADR-0004's explicit per-route dependency trace.

## Worked example: a transaction slot

This is the onion model earning its keep. The `examples/shop` app exposes a
per-request unit of work as a scoped slot. The middleware opens a transaction from the
`store` singleton, fills the `tx` slot, and — critically — **rolls back on any path
that did not commit**:

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

It is the canonical shape of a slot-providing middleware that also owns cleanup, and
you can read it straight off the onion — steps 1–2 happen on the way in, steps 4–5 on
the way out:

1. **Open** the resource from a singleton (`c.get('store').begin()`).
2. **Fill** the scoped slot (`c.set('tx', tx)`) so the handler can stage work on it.
3. **Run** the rest of the chain inside `try { await next() }`.
4. **Roll back on a throw**, then rethrow so the error still reaches the 5xx
   boundary.
5. **Roll back after `next()`** if the handler never committed — an early
   `c.error(...)` short-circuit returns control here with the transaction still
   `open`.

The handler reads the slot, stages its writes, and commits explicitly on success;
anything else leaves the transaction un-committed, and the middleware discards the
staged work — so a partial write never reaches the store. The slot's type comes from
`defineContext` (`tx: scoped<Transaction>()`), so `c.get('tx')` is fully typed in the
handler.

## See also

- [Context & DI](/guide/context-di) — declaring singletons and scoped slots.
- [Routes & schemas](/guide/routes-schemas) — `defineRoute`, `use:`, and the `output` contract.
- [App-level middleware](/guide/app-middleware) — the global chain in depth.
- [JWT auth](/guide/jwt) — `jwtAuth`, guards, and the `currentUser` slot.
- [Errors](/guide/errors) — the unified envelope `c.error` builds.
