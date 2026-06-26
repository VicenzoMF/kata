---
title: createApp
description: Wire your modules and middleware into a typed Hono app, then serve it.
---

# createApp

`createApp` turns your modules into a running Hono app. It is the last call in
your app: `defineContext` builds the registry, `defineRoute` declares the
handlers, and `createApp` collects them, prepends the app-level middleware
chain, and returns a parametric Hono app you serve and export a type from.

`createApp` is one of the four functions `defineContext` returns. Call the bound
one, not a free import — it is already typed to your registry.

```ts
import { defineContext, singleton } from 'katajs'

export const k = defineContext({ logger: singleton(console) })
export const { defineRoute, defineMiddleware, createApp } = k
```

## Signature

```ts
function createApp<const Mods extends readonly Module<R>[]>(
  config: AppConfig<R, Mods>,
): KataApp<Mods>
```

`config` is an `AppConfig`:

```ts
type AppConfig<R extends Registry, Mods extends readonly Module<R>[]> = {
  modules: Mods
  middlewares?: readonly Middleware<R>[]
  requestLogging?: boolean
  outputValidation?: 'strict' | 'log' | 'off'
}
```

### `modules` (required)

A tuple of modules. A **module** is the namespace import of a `*.route.ts`
file — `import * as users from './modules/users/users.route'`. `createApp`
registers every exported route in each module, in array order.

```ts
import { createApp } from './context'
import * as users from './modules/users/users.route'
import * as orders from './modules/orders/orders.route'

const app = createApp({ modules: [users, orders] })
```

A route's `path` and `method` come from its own `defineRoute` call. `createApp`
does not prefix or rewrite paths; what you declare is what is served.

### `middlewares` (optional)

An app-level middleware chain that runs **before** every route's own `use:`. The
effective per-route chain is `[...middlewares, ...route.use]`, each in declared
order, the global chain outermost ([ADR-0012](/adr/0012-app-level-middleware)).
It is the same `Middleware<R>` contract route middleware uses: a global may
short-circuit by returning a `Response`, and any scoped slot it `provides:` is
readable via `c.get` in every handler.

Declare cross-cutting concerns once here instead of repeating them on each route.
The first-party hardening built-ins are the canonical case:

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'

const app = createApp({
  modules: [users, orders],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

See [/guide/app-middleware](/guide/app-middleware) for ordering and
short-circuit semantics, and [/reference/middleware](/reference/middleware) for
the built-ins.

### `requestLogging` (optional)

Per-request logging. Defaults to `true`. When enabled and a `logger` singleton
is registered, every request is logged — method, path, status, duration, and
request id — through it. It is a no-op when no usable `logger` is registered; set
`false` to silence it explicitly.

```ts
const app = createApp({ modules: [users], requestLogging: false })
```

The request id is also echoed on the `x-request-id` response header
(`REQUEST_ID_HEADER`).

### `outputValidation` (optional)

How an output-schema mismatch is handled ([ADR-0009](/adr/0009-output-validation-mode)):

- `'strict'` — log the offending Zod issues and respond `500
  {"error":"internal_output_shape_mismatch"}`. The wrong shape never reaches the
  client.
- `'log'` — log the issues, then send the handler's data through unchanged.
- `'off'` — skip output validation entirely.

Defaults to `'strict'` outside production and `'log'` in production. Override it
here, or via the `KATA_OUTPUT_VALIDATION` env var.

```ts
const app = createApp({
  modules: [users],
  outputValidation: process.env['NODE_ENV'] === 'production' ? 'log' : 'strict',
})
```

Input validation is not configurable — invalid input always yields a `422`
before the handler runs. See [/guide/errors](/guide/errors) for both envelopes.

## The return value: `KataApp` and `AppType`

`createApp` returns a `KataApp<Mods>` — a parametric Hono app whose type carries
every route the modules declare:

```ts
type KataApp<Mods extends readonly RpcModule[]> =
  Hono<BlankEnv, ModulesToHonoSchema<Mods>>
```

It is a real Hono app at runtime; the type parameter is what powers the typed
RPC client. Export that type from your server — it is the only thing a client
needs:

```ts
export const app = createApp({ modules: [users] })
export type AppType = typeof app // ≡ KataApp<[typeof users]>
```

The DI registry never reaches the wire, so the client's Hono `Env` stays
`BlankEnv`. A client consumes the type with zero codegen:

```ts
import { hc } from 'hono/client'
import type { AppType } from 'server'

const client = hc<AppType>('http://localhost:3000')
```

See [/guide/rpc-client](/guide/rpc-client) for the full client walkthrough.

## Serving the app

Because the return value is a Hono app, you serve it through `app.fetch` — the
standard Web `Request → Response` handler Hono exposes. On Node, hand it to
`@hono/node-server`:

```ts
import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

`createApp` installs **no** signal handlers and owns no server socket. It builds
the request handler; `serve` owns the socket. Opting into graceful shutdown is a
separate, explicit step ([ADR-0014](/adr/0014-lifecycle-shutdown)).

### Graceful shutdown — `kata/node`

`@hono/node-server`'s `serve()` returns a server handle. Pass it to
`gracefulShutdown` from `kata/node` to drain in-flight requests on `SIGTERM` /
`SIGINT` before the process exits:

```ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'katajs/node'

import { createApp, k } from './context'
import * as products from './modules/products/products.route'

const app = createApp({ modules: [products] })

const port = Number(process.env['PORT'] ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})

gracefulShutdown(server, {
  onClose: async () => {
    await k.registry.store.__value.close()
  },
})
```

On the first trapped signal, `gracefulShutdown` stops accepting new connections,
lets in-flight requests drain, then runs your `onClose` — strictly after the
drain, so no live handler loses its pool or transaction mid-query. Resource
teardown order is yours to sequence inside `onClose`; Kata owns no dispose
registry.

```ts
type GracefulShutdownOptions = {
  onClose: () => void | Promise<void>
  signals?: readonly NodeJS.Signals[] // default: ['SIGTERM', 'SIGINT']
  timeoutMs?: number                  // default: 10_000
}
```

::: tip
`kata/node` is the only entry that touches `node:process`. Importing the
runtime-neutral root (`kata`) from an edge or Workers build never pulls it in
([ADR-0014](/adr/0014-lifecycle-shutdown)).
:::

See [/guide/lifecycle](/guide/lifecycle) for the full drain sequence, the
force-exit timer, and the `main.ts` boundary.

### Other runtimes

`app.fetch` is the universal handler. On Bun, Deno, or an edge/Workers runtime,
hand it to that platform's server instead of `@hono/node-server`. Kata's core
(`kata`) is runtime-neutral; only `kata/node` is Node-specific.

```ts
// Bun
export default { fetch: app.fetch }
```
