---
title: defineMiddleware
description: API reference for defineMiddleware — the config shape, the provides typing, the MiddlewareContext, and short-circuiting.
---

# defineMiddleware

`defineMiddleware` produces a `Middleware<R>`: a value that prepares a request
before the handler runs and fills the **scoped slots** declared in
`defineContext`. It is returned by `defineContext`, bound to your registry `R`,
so import it from your context module — not from `katajs`.

```ts
import { defineMiddleware } from '../context'
```

For the narrative — how middleware composes onto routes, fills slots, and
short-circuits — see [Middleware & scoped slots](/guide/middleware). This page is
the signature reference.

## Signature

```ts
defineMiddleware<const P extends readonly ScopedKeys<R>[]>(config: {
  provides: P
  handler: (
    c: MiddlewareContext<R>,
    next: () => Promise<void>,
  ) => Promise<void | Response> | void | Response
}): Middleware<R>
```

The config has exactly two fields, both required:

| Field | Type | Purpose |
| --- | --- | --- |
| `provides` | `readonly ScopedKeys<R>[]` | The scoped slot keys this middleware fills. |
| `handler` | `(c, next) => Promise<void \| Response> \| void \| Response` | Runs the setup, fills slots, optionally short-circuits. |

The returned value is opaque — `{ __kata: 'middleware', provides, handler }`. You
do not read its fields; you pass it to a route's `use:` or the app's
`middlewares:`.

## `provides` and `as const`

`provides` lists the scoped slot keys the middleware fills. Its element type is
`ScopedKeys<R>` — only **scoped** keys from your registry are accepted; a
singleton key or an unknown string is a type error.

Write the array `as const`:

```ts
provides: ['currentUser'] as const
```

Without `as const`, the array widens to `string[]` and the literal keys are lost.
`as const` keeps them as a tuple of string literals, which does two things:

- The keys stay greppable and lint-checkable. The
  `kata/scoped-slot-not-provided` rule unions the `provides` of a route's chain
  to prove every `c.get('slot')` in the handler has a provider.
- The compiler holds each entry to `ScopedKeys<R>`, so a typo or a non-scoped key
  fails at the `defineMiddleware` call site.

A middleware that fills no slot — one that only reads a header or rejects a
request — declares an empty tuple:

```ts
provides: [] as const
```

## The handler

```ts
handler: (
  c: MiddlewareContext<R>,
  next: () => Promise<void>,
) => Promise<void | Response> | void | Response
```

`c` is the [middleware context](#middlewarecontext). `next` continues the chain;
`await` it to run the remaining middleware and (eventually) the handler. Code
after `await next()` runs on the way back out — this is where cleanup belongs.

A handler does one of:

- **Continue** — call `await next()` and return nothing (`void`).
- **Short-circuit** — return a `Response` (see [below](#short-circuiting)).

```ts
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

This is the `examples/shop` toy auth verbatim. It reads a header, rejects when it
is missing, and otherwise fills the `currentUser` scoped slot before continuing.

## `MiddlewareContext`

`c` is a `MiddlewareContext<R>` — a smaller surface than the route context (it
has no `input`). Every method is typed against your registry `R`.

```ts
type MiddlewareContext<R extends Registry> = {
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  set<K extends ScopedKeys<R>>(key: K, value: ResolvedValue<R[K]>): void
  raw: import('hono').Context
  header(name: string): string | undefined
  json<T>(value: T, status?: number): Response
  error(code: string, message: string, extra?: ErrorExtra): Response
  requestId: string
}
```

| Member | Behaviour |
| --- | --- |
| `c.get('key')` | Read any registered slot — a singleton, or a scoped slot already filled this request. Compiles for any registered key. Reading a scoped slot before it is set throws. |
| `c.set('key', value)` | Fill a **scoped** slot. The type parameter is `ScopedKeys<R>`, so it only compiles for scoped keys; passing a singleton key throws at runtime. |
| `c.header('name')` | Read a request header. Returns `string \| undefined`. |
| `c.json(value, status?)` | Build a JSON `Response`. `status` defaults to `200`. Return it to short-circuit. |
| `c.error(code, message, extra?)` | Build the unified error envelope (ADR-0008). `extra.status` defaults to `400`. Return it to short-circuit. |
| `c.requestId` | The correlation id for this request — the inbound `x-request-id` when well-formed, otherwise a fresh UUID. |
| `c.raw` | The underlying Hono `Context`. An escape hatch. |

::: warning `c.header` reads, it does not write
`c.header(name)` is a request-header **getter**. There is no setter for response
headers and no body post-processing: Kata builds its response detached from
`c.res`, so a chain prepares the request and may short-circuit, but cannot
rewrite the final body. Response transformers (compression, ETag) do not belong
in a middleware. To set a response header, do it on `c.raw` before returning, or
build the `Response` yourself.
:::

## Short-circuiting

The handler's return type is `Promise<void | Response> | void | Response`.
**Returning a `Response` stops the request immediately** — every later
middleware, the input validation, and the handler are all skipped. Returning
`void` (or just calling `await next()`) continues.

Build the short-circuit `Response` with `c.error(...)` for an expected rejection
or `c.json(...)` for a custom success:

```ts
handler: async (c, next) => {
  const token = c.header('authorization')
  if (!token) return c.error('unauthorized', 'Missing Authorization header', { status: 401 })
  // ...verify, fill slot...
  await next()
}
```

A short-circuit response still flows through the rest of the pipeline's
bookkeeping — it gets the `x-request-id` header and is logged like any other
outcome. Because it never reaches the handler, a status raised by a middleware is
**not** part of the route's `output` contract; do not declare it in `output:`.

Throwing also stops the request, but as an unhandled error: it is logged
server-side and funnelled into the unified `500 internal_error` envelope. Use
`return c.error(...)` for an expected rejection; let a throw signal a genuine
bug. See [Errors](/guide/errors).

## Relation to scoped slots

A scoped slot (declared `scoped<T>()` in `defineContext`) starts each request
empty and is filled by a middleware. The contract is two-sided:

- `provides` is the **type-level** declaration of which slots the middleware
  fills, enforced against `ScopedKeys<R>` and checked by the
  `kata/scoped-slot-not-provided` lint rule.
- `c.set('key', value)` is the **runtime** fill. The value's type is
  `ResolvedValue<R[K]>` — the `T` you gave `scoped<T>()`.

A handler reads the slot with `c.get('key')` and gets it back fully typed. The
read is only sound if a providing middleware ran first; otherwise it throws
(`scoped slot 'key' read before being set`). Singletons need no provider — they
live for the process lifetime.

A middleware that owns a resource can also clean up after `next()`. The
`examples/shop` transaction slot opens a unit of work, fills the slot, and rolls
back on any path that did not commit:

```ts
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

See [Middleware & scoped slots](/guide/middleware) for the full slot lifecycle
and [Context & DI](/guide/context-di) for declaring slots in `defineContext`.

## Composition

A `Middleware<R>` is composed in one of two places, both taking
`readonly Middleware<R>[]`:

- **Per route** — `defineRoute({ use: [requireAuth, withTransaction], ... })`.
  The chain runs left to right before the handler. See
  [defineRoute](/reference/define-route).
- **App-wide** — `createApp({ middlewares: [secureHeaders(), cors()], ... })`.
  Runs before every route's own `use:`; the effective chain for a route is
  `[...config.middlewares, ...route.use]`. See [createApp](/reference/create-app).

The same instance composes onto as many routes as you like — there is no
per-route duplication.

## See also

- [Middleware & scoped slots](/guide/middleware) — the full guide.
- [defineContext](/reference/define-context) — declaring scoped slots and singletons.
- [defineRoute](/reference/define-route) — `use:` and the `output` contract.
- [createApp](/reference/create-app) — the app-level `middlewares:` chain.
- [Built-in middleware](/reference/middleware) — `cors`, `secureHeaders`, `bodyLimit`.
- [JWT auth](/reference/jwt) — `jwtAuth` and the guards.
