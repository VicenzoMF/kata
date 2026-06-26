---
title: Context & DI
description: defineContext is the single dependency registry. Declare singletons and scoped slots, re-export the bound factory, and read everything through a monomorphic c.get.
---

# Context & DI

## The problem this solves

Every route needs things it didn't build itself — a database connection, a
logger, the currently logged-in user. *Dependency injection* (DI) is just the
discipline of declaring those things in one place and letting the framework hand
them to each route, instead of every route importing or constructing them on its
own.

Most frameworks do this with an *IoC container*: a runtime object you register
classes with, which then constructs them, figures out what depends on what, and
wires it all together as the app boots — usually driven by decorators and
reflection. **Kata has none of that.** No container, no decorators, no
reflection. Its registry is a plain object literal, and the wiring is checked by
the type system at compile time instead of resolved by a container at runtime.

That registry is a single call to `defineContext`. It is the one place both the
type system *and* the lint harness read to answer "what dependencies exist?" If
something isn't declared there, `c.get` for it simply does not compile.

```ts
import { defineContext, scoped, singleton } from 'katajs'

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

A dependency in Kata is a *slot*: a named place in the registry that holds a
value. Every slot is built by one of two constructors, and choosing between them
is really a question about **lifetime** — how long the value lives, and who puts
it there.

- `singleton(value)` — **one value, built once, shared by every request for the
  life of the process.** The database pool, the logger, the mailer, the cache
  client: things that are expensive to build and safe to reuse. You construct the
  value yourself and pass it in; Kata just holds onto it.
- `scoped<T>()` — **one value per request, fresh each time a request arrives.**
  The current user, the tenant id, an open transaction: things that *differ on
  every request* and would be a bug to share between them. You pass no value here,
  only its type — because there is nothing to build at startup. The value shows up
  later, at request time, put there by a middleware.

The scoped kind is the one that trips people up, so here is the timeline it
implies:

1. **At startup**, Kata builds each `singleton` once. Every `scoped` slot is
   registered but left empty.
2. **A request arrives.** Middleware runs first; a middleware that *provides* a
   scoped slot computes its value and sets it — decodes the JWT, looks up the
   user, calls `c.set('currentUser', …)`.
3. **The handler runs** and reads slots with `c.get`. Singletons return the value
   from step 1; a scoped slot returns the value step 2 set, for *this* request
   only.
4. **The request ends** and the scoped values are thrown away. The next request
   starts over from an empty slot.

```ts
import { defineContext, scoped, singleton } from 'katajs'
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

Two details on how you type each one:

- `singleton(value)` infers `T` from the value you pass. When you need a wider
  type than the literal — an interface that a concrete object happens to satisfy —
  annotate the call: `singleton<Store>(createStore())`.
- `scoped<T>()` takes no value, only the type parameter. The slot stays empty
  until a middleware sets it.

::: info Why two kinds and nothing else
The rule that a scoped `c.get` always returns a plain `T` — never `Promise<T>`,
never `T | undefined` — is what keeps handler code free of defensive `await`s and
`?.` checks. Kata rejected the obvious alternative, lazy factories, for exactly
that reason: a factory model makes `c.get` return `T` for some keys and
`Promise<T>` for others, and forces the harness to resolve call graphs instead of
reading one file. See [ADR-0004](/adr/0004-di-via-scoped-slots).
:::

## What defineContext returns — and why it's "bound"

`defineContext(registry)` doesn't just file your slots away; it hands back a
small set of functions that *already know* about them. This is the trick that
makes `c.get('logger')` type-check while `c.get('logr')` doesn't — the knowledge
of your exact keys is baked into the functions you get out.

It returns a frozen object with four members:

```ts
const { registry, defineMiddleware, defineRoute, createApp } = defineContext({ /* … */ })
```

- `defineRoute` — define a route. Its `c.get` and `use:` chain know your slots.
- `defineMiddleware` — define a middleware. Its `provides:` is constrained to your
  scoped slot names.
- `createApp` — assemble the app from modules and app-level middleware.
- `registry` — the registry object itself, for deriving `AppRegistry`.

The phrase "bound to your registry" is worth unpacking, because it is the whole
mechanism. The generic `defineRoute` you could import from `katajs` knows nothing
about *your* slots — it can't, it shipped long before your app existed. The
`defineRoute` that comes *out of your `defineContext` call* is a specialized copy
whose types are parameterized by your registry. Same runtime function, but now
its `c.get` accepts only your keys and returns only your value types.

That is why there are two places to import from — and confusing them is the most
common context mistake:

| Import from `katajs` (generic)           | Import from your `context.ts` (bound)          |
|----------------------------------------|------------------------------------------------|
| `defineContext`, `singleton`, `scoped` | `defineRoute`, `defineMiddleware`, `createApp` |

### Re-export the bound factory

So `context.ts` re-exports the bound functions, and every module imports them from
that one local path:

```ts
export const { defineRoute, defineMiddleware, createApp } = k
```

A route file then does:

```ts
import { defineRoute } from '../../context'
```

This is what makes `c.get('key')` resolve against your registry everywhere.

**The mistake to avoid:** importing `defineRoute` straight from `katajs`, or calling
`defineContext` again inside a route file. Either one hands you back the *generic,
unbound* factory — the one that doesn't know your slots — so `c.get` quietly loses
its key checking and the type chain goes slack without any error to warn you.

## Reading slots: c.get

Everything you register is read back through `c` — the **context object** Kata
passes to every handler and every middleware. Think of `c` as your single handle
to the current request: it carries the validated `c.input`, response helpers like
`c.json` and `c.error`, the correlation id `c.requestId`, and — the part this page
is about — `c.get`, the typed reader for your registry.

`c.get` does exactly one thing: you give it a slot name, it gives you that slot's
value.

```ts
get<K extends keyof R>(key: K): ResolvedValue<R[K]>
// K                   → one of the slot names you registered (R = your registry)
// ResolvedValue<R[K]> → the value type that slot resolves to
```

There is no second argument and no options object — a name goes in, the value
comes out. It doesn't matter whether the slot is a process-wide `singleton` or a
per-request `scoped` value: `c.get` reads both the same way, because the lifetime
difference was already settled when you declared the slot. `c.get` just resolves
whatever is currently in it.

Inside a handler or a middleware, then, reading a slot looks like this:

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

Two properties of `c.get` are worth naming, because they are what make it pleasant
to use:

- **It's synchronous.** `c.get` never returns a promise — you never `await` a
  dependency. Whatever the slot holds, you receive the value directly. (This is
  the concrete payoff of banning lazy factories.)
- **It's monomorphic** — it has exactly *one* return type per key, fixed by the
  registry: `ResolvedValue<R[K]>`. A singleton key returns precisely the type you
  registered; a scoped key returns precisely the type its middleware sets. No
  union to narrow, no widening, no `| undefined` to guard against.

And it only type-checks for keys you actually declared. A typo or an undeclared
name is a compile error, and the `kata/context-key-not-registered` lint rule flags
it too — so you find out as you type, not in production.

::: warning Reading a singleton at startup
The five returned members are the public surface. Outside a request you have no
`c`; to reach a singleton at boot — for example to log the listening port — call
`k.resolve('logger').info(...)`. `resolve` is singleton-only: a scoped slot has no
value at startup by definition, so reaching for one outside a request handler is a
build-time error (`kata/scoped-read-outside-request`).
:::

## Filling scoped slots happens in middleware

This is the other half of the scoped-slot story from above. A `scoped<T>()` slot
starts empty, and the *only* way it ever gets a value is a middleware putting one
there. The middleware declares which slots it `provides`, and in return the runtime
hands it a `c.set` that accepts exactly those slots:

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

Read that as a contract with two sides:

- The middleware *promises*, via `provides: ['currentUser'] as const`, that once it
  has run, `currentUser` is set. The `as const` is load-bearing: without it
  TypeScript widens the array to `string[]` and the literal slot name is lost.
- A route that reads `c.get('currentUser')` must list `requireAuth` in its `use:`
  chain. That listing is the actual wire that delivers the value — reading a slot
  and providing it are connected by the `use:` chain, nothing else.

The type system and the harness keep both sides of that contract honest:

- `provides` is constrained to your scoped slot names, and `c.set` accepts only
  those keys with the right value type. Setting a singleton, or a name you never
  declared, does not compile.
- `kata/scoped-slot-not-provided` fails a route that reads a scoped slot whose
  providing middleware is not in its `use:` chain.
- `kata/middleware-provides-mismatch` fails a middleware that declares a slot in
  `provides` but never actually sets it.

And if the wiring is wrong anyway — the providing middleware never runs — the slot
stays empty, and Kata refuses to paper over it with `undefined`. `c.get` throws,
loudly:

> `kata: scoped slot 'currentUser' read before being set. Did the providing middleware run?`

The throw is deliberate. A silent `undefined` would turn a wiring mistake into a
null-reference crash three lines later, far from its cause; throwing at the read
points straight at the problem. The lint rules above exist to catch the same
mistake even earlier, before the code ever runs.

For the full middleware contract — `provides`, the context API, short-circuiting
with a `Response` — see [Middleware](/guide/middleware).

## Why static enumerability matters

Everything above buys one property, and it is the reason the design looks the way
it does: **the entire dependency graph is one object literal in one file.** Nothing
is computed, registered dynamically, or hidden behind a factory call. So every
question about dependencies collapses to a read or a grep:

- *What dependencies exist?* → read `src/context.ts`.
- *Which routes use `currentUser`?* → grep for `c.get('currentUser')`.

That is not just a convenience for humans. Kata's correctness story rests on
multi-file invariants a fast checker can verify mechanically — every scoped read
has a providing middleware, every `c.get` key is registered. Those checks are cheap
*only because* the registry is statically enumerable: the checker greps and
pattern-matches instead of running a type-level proof search or booting your app.
See [The harness](/guide/harness).

## AppRegistry

Export the registry's type whenever something needs to *name* your context —
a middleware contract, a test helper, a function generic over the app:

```ts
export type AppRegistry = typeof k.registry
```

`AppRegistry` is the `Registry` your slots define: a readonly record from each key
to its `Singleton<T>` or `Scoped<T>`. The bound `defineRoute`, `defineMiddleware`,
and `createApp` are all parameterized over it — so naming it once keeps the rest of
your code in step with `context.ts`.

## Next

- [Routes & schemas](/guide/routes-schemas) — define a route over this context.
- [Middleware](/guide/middleware) — fill scoped slots and run cross-cutting logic.
- [create-app reference](/reference/create-app) — assemble modules into an app.
- [ADR-0004](/adr/0004-di-via-scoped-slots) — why singletons + scoped slots.
