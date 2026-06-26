---
title: defineContext
description: The single dependency registry — singleton and scoped slots, the bound factory, and how c.get is typed.
---

# defineContext

`defineContext` is the single place dependencies are registered. There is no
runtime IoC container and no string-keyed service locator: the registry is a
plain object, and the keys you pass become the only keys `c.get` will accept.
It is imported from the core entry point alongside the two slot constructors.

```ts
import { defineContext, scoped, singleton } from 'katajs'
```

## Signature

`defineContext` takes one argument — the registry — and returns the factory
functions bound to it.

```ts
function defineContext<const R extends Registry>(
  registry: R,
): {
  registry: R
  defineMiddleware: /* bound to R */
  defineRoute: /* bound to R */
  createApp: /* bound to R */
}
```

The `const` type parameter preserves the exact literal type of the registry —
each key, and whether its slot is a singleton or scoped — so that information
flows into every route, middleware, and `c.get` call downstream.

A `Registry` is a read-only record of slots:

```ts
type Slot = Singleton<unknown> | Scoped<unknown>
type Registry = Readonly<Record<string, Slot>>
```

## Slot constructors

A registry value is never a bare value. It is a slot, built by one of two
constructors, which tags the value with its lifetime ([ADR-0004](/adr/0004-di-via-scoped-slots)).

### `singleton`

```ts
function singleton<T>(value: T): Singleton<T>
```

`singleton(value)` holds one value for the process lifetime. Use it for things
created once at boot: a database pool, a logger, a mailer, a configuration
object. The value is resolved eagerly — you pass it in here, and every
`c.get` returns that same reference.

```ts
const logger: Logger = {
  info: (msg, extra) => console.log(`[app] ${msg}`, extra ?? ''),
}

const slots = {
  logger: singleton(logger),
}
```

### `scoped`

```ts
function scoped<T>(): Scoped<T>
```

`scoped<T>()` declares one value per request. It takes no argument — there is
nothing to provide at registration time. The value is filled later, per
request, by a middleware that declares the slot in its `provides:` list and
sets it with `c.set` (see [Middleware](/guide/middleware) and
[`defineMiddleware`](/reference/define-middleware)). Use it for the current
user, a tenant id, or a per-request transaction.

```ts
const slots = {
  currentUser: scoped<User>(),
  tx: scoped<Transaction>(),
}
```

::: warning Reading a scoped slot before it is set throws
A scoped slot has no value until the providing middleware runs. Reading one in
a handler whose `use:` chain never fills it throws at runtime:

```
kata: scoped slot 'currentUser' read before being set. Did the providing middleware run?
```

A route that reads a scoped slot must list the providing middleware in its
`use:` chain, or register it as an app-level middleware in
[`createApp`](/reference/create-app).
:::

## The returned factory

`defineContext` returns four members, all bound to your registry `R`:

| Member | Type | Purpose |
| --- | --- | --- |
| `registry` | `R` | The literal registry, for `typeof k.registry`. |
| `defineRoute` | bound | [`defineRoute`](/reference/define-route) — its `c.get` and `use:` know `R`. |
| `defineMiddleware` | bound | [`defineMiddleware`](/reference/define-middleware) — `provides:` is keyed to your scoped slots. |
| `createApp` | bound | [`createApp`](/reference/create-app) — builds the Hono app. |

Define the context once, in `src/context.ts`, then re-export the bound factory
functions. The rest of the app imports them from there and inherits the types
automatically — nothing else ever calls `defineContext`.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import type { User } from './modules/users/users.schema'

type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[app] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  logger: singleton(logger),
  currentUser: scoped<User>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

::: tip Export the registry type
`export type AppRegistry = typeof k.registry` gives you a name for the registry
shape. It is the `R` that parameterizes `Route<R>` and `Middleware<R>`, useful
when you write a helper that is generic over any context.
:::

## How `c.get` is typed

`c.get` is the only way to read a dependency, in both route and middleware
handlers. Its key parameter is constrained to `keyof R`, so an unregistered key
is a compile error — not a runtime surprise:

```ts
get<K extends keyof R>(key: K): ResolvedValue<R[K]>
```

The return type is unwrapped from the slot by `ResolvedValue`, so you get the
underlying value type back, not the slot wrapper:

```ts
type ResolvedValue<S> =
  S extends Singleton<infer T> ? T : S extends Scoped<infer T> ? T : never
```

Given the context above:

```ts
const log = c.get('logger') // Logger
const user = c.get('currentUser') // User
c.get('mailer') // ✗ compile error — not registered in defineContext
```

::: info Scoped keys are typed everywhere `get` is callable
In v1, `c.get` types every registered key in a handler, including scoped ones —
whether the route's middleware chain actually provided a given scoped slot is a
lint concern, not a type error. Reading an unprovided scoped slot still throws
at runtime, as shown above. See [ADR-0004](/adr/0004-di-via-scoped-slots).
:::

## Worked example

A context with both slot kinds, the bound factory re-exported, and a handler
that reads each:

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import type { Store } from './store'
import { createStore } from './store'

export type CurrentUser = { id: string }

export const k = defineContext({
  store: singleton<Store>(createStore()),
  currentUser: scoped<CurrentUser>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

```ts
// src/modules/orders/orders.route.ts
import { z } from 'zod'

import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'
import { OrderSchema } from './orders.schema'
import { listOrders } from './orders.service'

export const list = defineRoute({
  method: 'GET',
  path: '/orders',
  use: [requireUser], // fills the `currentUser` scoped slot
  input: {},
  output: z.array(OrderSchema),
  handler: (c) => {
    const store = c.get('store') // Store — singleton, always available
    const user = c.get('currentUser') // CurrentUser — provided by requireUser
    return listOrders(store, user.id)
  },
})
```

## Helper types

These are exported from the core entry point for advanced use — writing a
function generic over any registry, or inspecting slot kinds. You rarely need
them in application code.

| Type | Meaning |
| --- | --- |
| `Singleton<T>` | A process-lifetime slot holding a `T`. |
| `Scoped<T>` | A per-request slot for a `T`, filled by middleware. |
| `Slot` | `Singleton<unknown> \| Scoped<unknown>`. |
| `Registry` | `Readonly<Record<string, Slot>>`. |
| `ResolvedValue<S>` | The value type a slot `S` resolves to. |
| `SingletonKeys<R>` | The union of keys in `R` whose slot is a singleton. |
| `ScopedKeys<R>` | The union of keys in `R` whose slot is scoped. |

## See also

- [Context and DI](/guide/context-di) — the conceptual guide.
- [Middleware](/guide/middleware) — how scoped slots get filled.
- [`defineMiddleware`](/reference/define-middleware) — the `provides:` contract.
- [`defineRoute`](/reference/define-route) — `c.get` and `use:` in a handler.
- [`createApp`](/reference/create-app) — assembling modules and middleware.
- [ADR-0004](/adr/0004-di-via-scoped-slots) — why DI is two slot kinds and nothing else.
