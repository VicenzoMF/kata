---
title: Context & DI
description: defineContext is the single dependency registry. Declare singletons and scoped slots, re-export the bound factory, and read everything through a monomorphic c.get.
---

# Context & DI

Kata has no IoC container, no decorators, no reflection. Dependencies live in one
place: a call to `defineContext`. That call is the single registry the type system
and the lint harness read. If a dependency is not declared there, `c.get` does not
compile.

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

This file is `src/context.ts`. See [Project layout](/guide/project-layout).

## Two slot kinds

`defineContext` takes a record. Every value is a slot built by one of two
constructors. There is no third kind.

- `singleton(value)` — one value for the whole process. The pool, the logger, the
  mailer, the cache client. You pass the constructed value in; Kata holds it.
- `scoped<T>()` — one value per request. The current user, the tenant id, an open
  transaction. You declare only the type. The value is filled at request time by a
  middleware, never at startup.

```ts
import { defineContext, scoped, singleton } from 'kata'
import type { Store, Transaction } from './store'
import { createStore } from './store'

export type CurrentUser = { id: string }

export const k = defineContext({
  // Shared singletons.
  store: singleton<Store>(createStore()),
  logger: singleton(logger),
  // Request-scoped slots: populated by middleware, never global state.
  currentUser: scoped<CurrentUser>(),
  tx: scoped<Transaction>(),
})
```

`singleton(value)` infers `T` from what you pass. When you need a wider type than
the literal value — an interface a concrete object satisfies — annotate the call:
`singleton<Store>(createStore())`.

`scoped<T>()` takes no value, only the type parameter. The slot is empty until a
middleware sets it.

::: info Why two kinds and nothing else
A request-scoped value that you `c.get` always returns `T` — never `Promise<T>`,
never `T | undefined`. Kata rejected lazy factories for exactly this reason: a
factory model makes `c.get` return `T` for some keys and `Promise<T>` for others,
and forces the harness to resolve call graphs instead of reading one file. See
[ADR-0004](/adr/0004-di-via-scoped-slots).
:::

## What defineContext returns

`defineContext(registry)` returns a frozen object with four members, each already
bound to your registry:

```ts
const { registry, defineMiddleware, defineRoute, createApp } = defineContext({ /* … */ })
```

- `defineRoute` — define a route. Its `c.get` and `use:` chain know your slots.
- `defineMiddleware` — define a middleware. Its `provides:` is constrained to your
  scoped slot names.
- `createApp` — assemble the app from modules and app-level middleware.
- `registry` — the registry object itself, for deriving `AppRegistry`.

These are functions, not generic helpers you re-parameterize at each call. Import
the generic `defineContext` / `singleton` / `scoped` from `kata`; import
`defineRoute` / `defineMiddleware` / `createApp` from your own `context.ts`.

### Re-export the bound factory

Export `defineRoute`, `defineMiddleware`, and `createApp` from `context.ts` so the
rest of the app inherits the types. Every module then imports them from one local
path:

```ts
export const { defineRoute, defineMiddleware, createApp } = k
```

A route file:

```ts
import { defineRoute } from '../../context'
```

This is what makes `c.get('key')` resolve against your registry everywhere. Do not
re-import the generic `defineContext` in a route or middleware file — that
recreates an unbound factory and breaks the chain.

## Reading slots: c.get

Inside a handler or a middleware, read any declared slot with `c.get(key)`:

```ts
import { defineRoute } from '../../context'
import { UserSchema } from './users.schema'
import { requireUser } from '../../middlewares/auth'

export const me = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => {
    const logger = c.get('logger')      // Logger     (singleton)
    const user = c.get('currentUser')   // User       (scoped)
    logger.info('read profile', { id: user.id })
    return user
  },
})
```

`c.get` is monomorphic. It returns the resolved value type of the slot —
`ResolvedValue<R[K]>` — synchronously, for both kinds. A singleton returns the
value you registered; a scoped slot returns the value its middleware set.

`c.get('key')` only type-checks when `'key'` is a key of your registry. A typo or
an undeclared name is a compile error, and the `kata/context-key-not-registered`
lint rule flags it too.

::: warning Reading the registry at startup
The four returned members are the public surface. Outside a request you have no
`c`; to reach a singleton at boot — for example to log the listening port — read it
off the registry directly: `k.registry.logger.__value.info(...)`. Scoped slots have
no value at startup by definition, so reading one outside a request handler is a
build-time error (`kata/scoped-read-outside-request`).
:::

## Filling scoped slots happens in middleware

A `scoped<T>()` slot starts empty. A middleware fills it. The middleware declares
which slots it provides; the runtime gives it a `c.set` for exactly those slots:

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

`provides` must be `as const` so the literal slot names survive into the type. A
route that reads `c.get('currentUser')` lists `requireAuth` in its `use:` chain —
that is how the value gets there.

The `provides` array is type-constrained to your scoped slot names, and `c.set`
accepts only those keys with the right value type. Setting a singleton, or a name
you never declared, does not compile. The relationship between a scoped read and a
providing middleware is also a lint invariant: `kata/scoped-slot-not-provided`
fails a route that reads a scoped slot whose middleware is not in its `use:` chain,
and `kata/middleware-provides-mismatch` fails a middleware that declares a slot it
never sets.

If the providing middleware never runs, the slot is never set. Reading it then is
not a silent `undefined` — `c.get` throws at runtime:

> `kata: scoped slot 'currentUser' read before being set. Did the providing middleware run?`

The lint rules above exist to catch that wiring mistake before runtime.

For the full middleware contract — `provides`, the context API, short-circuiting
with a `Response` — see [Middleware](/guide/middleware).

## Why static enumerability matters

The whole registry is one object literal in one file. To answer "what dependencies
exist?" you read `src/context.ts`. To answer "which routes use `currentUser`?" you
grep for `c.get('currentUser')`. No factory graph to resolve, no container to
trace.

That is deliberate. Kata's correctness story rests on multi-file invariants a fast
checker can verify mechanically — every scoped read has a providing middleware,
every `c.get` key is registered. A single statically enumerable registry is what
makes those checks a grep instead of a type-level proof search. See
[The harness](/guide/harness).

## AppRegistry

Export the registry's type for reuse — middleware contracts, test helpers,
anything that needs to name your context:

```ts
export type AppRegistry = typeof k.registry
```

`AppRegistry` is the `Registry` your slots define: a readonly record from each key
to its `Singleton<T>` or `Scoped<T>`. It is the type the bound `defineRoute`,
`defineMiddleware`, and `createApp` are parameterized over, so naming it once keeps
the rest of your code in step with `context.ts`.

## Next

- [Routes & schemas](/guide/routes-schemas) — define a route over this context.
- [Middleware](/guide/middleware) — fill scoped slots and run cross-cutting logic.
- [create-app reference](/reference/create-app) — assemble modules into an app.
- [ADR-0004](/adr/0004-di-via-scoped-slots) — why singletons + scoped slots.
