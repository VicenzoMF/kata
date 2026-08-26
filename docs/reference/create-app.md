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
import { defineContext, singleton } from '@katajs-framework/core'

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
import { bodyLimit, cors, secureHeaders } from '@katajs-framework/core'

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

Independent of `requestLogging`, the request id is unconditionally echoed on
the `x-request-id` response header (`REQUEST_ID_HEADER`) — see
[Request id](/reference/middleware#request-id).

#### What makes a logger "usable"

A `logger` singleton is picked up automatically when its value structurally
satisfies the exported `Logger` type:

```ts
type Logger = {
  info(message: string, extra?: LogExtra): void
  warn?(message: string, extra?: LogExtra): void
  error?(message: string, extra?: LogExtra): void
}
```

Only `info` is required — `console` and most structured loggers (pino,
winston, …) satisfy it as-is. Kata checks for an `info` function at boot; a
`logger` singleton that fails the check (not an object, or no `info` method)
is treated as if none were registered — `requestLogging` becomes a silent
no-op, and the framework diagnostics below fall back to `console.error` /
`console.warn` instead. `warn` and `error` are optional: a one-method logger
still works, it just receives every event through `info`.

#### The per-request record

Every completed request logs one line shaped as `RequestLogFields`:

```ts
type RequestLogFields = {
  requestId: string
  method: string
  path: string
  status: number
  durationMs: number
}
```

That object is passed as `extra`; the message is
`` `${method} ${path} ${status} ${durationMs}ms` ``. The level tracks the
status class, cascading down to a level the logger actually implements:

| Status | Preferred level | Cascades to |
|---|---|---|
| `>= 500` | `error` | `warn`, then `info` |
| `400`–`499` | `warn` | `info` |
| `< 400` | `info` | — |

This runs for every outcome — a normal response, a `422` input-validation
failure, a middleware short-circuit, the `500` error boundary, or an unmatched
route — so no request goes unlogged.

#### Framework diagnostics

Three more events log through the same `logger`. Unlike request completion
above, these never cascade to a different level — each targets one level and,
when the logger doesn't implement it, falls back to the matching `console`
method instead:

| Event | Level | Fallback | When |
|---|---|---|---|
| Output-schema mismatch | `error` | `console.error` | The handler's response doesn't match its declared `output` ([ADR-0009](/adr/0009-output-validation-mode)) |
| `raw()` output content-type mismatch | `error` | `console.error` | A `raw()` response's actual `content-type` doesn't match the one it declares ([ADR-0024](/adr/0024-raw-output-contracts-and-response-validation)) |
| Unhandled error | `error` | `console.error` | A throw escapes a route handler, app-level middleware, or the global error boundary — see [/guide/errors](/guide/errors) |
| Unvalidated `raw()` body | `warn` | `console.warn` | Logged once at startup (not per request) when a route declares `raw()` output and `outputValidation` is `'log'`, since the body is only checked in `'strict'` mode |

The unhandled-error diagnostic hands `logger.error` a pre-flattened
`SerializedError` under `extra.err` — never a raw `Error` — so a
`JSON.stringify`-based logger can't lose `message` / `stack` to `Error`'s
non-enumerable properties. See [/guide/errors](/guide/errors) for the exact
shape.

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
  k.resolve('logger').info(`listening on http://localhost:${info.port}`)
})
```

`createApp` installs **no** signal handlers and owns no server socket. It builds
the request handler; `serve` owns the socket. Opting into graceful shutdown is a
separate, explicit step ([ADR-0014](/adr/0014-lifecycle-shutdown)).

### Graceful shutdown — `@katajs-framework/core/node`

`@hono/node-server`'s `serve()` returns a server handle. Pass it to
`gracefulShutdown` from `@katajs-framework/core/node` to drain in-flight requests on `SIGTERM` /
`SIGINT` before the process exits:

```ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from '@katajs-framework/core/node'

import { createApp, k } from './context'
import * as products from './modules/products/products.route'

const app = createApp({ modules: [products] })

const port = Number(process.env['PORT'] ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  k.resolve('logger').info(`listening on http://localhost:${info.port}`)
})

gracefulShutdown(server, {
  onClose: async () => {
    await k.resolve('store').close()
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
`@katajs-framework/core/node` is the only entry that touches `node:process`. Importing the
runtime-neutral root (`@katajs-framework/core`) from an edge or Workers build never pulls it in
([ADR-0014](/adr/0014-lifecycle-shutdown)).
:::

See [/guide/lifecycle](/guide/lifecycle) for the full drain sequence, the
force-exit timer, and the `main.ts` boundary.

### Other runtimes

`app.fetch` is the universal handler. On Bun, Deno, or an edge/Workers runtime,
hand it to that platform's server instead of `@hono/node-server`. Kata's core
(`@katajs-framework/core`) is runtime-neutral; only `@katajs-framework/core/node` is Node-specific.

```ts
// Bun
export default { fetch: app.fetch }
```
