---
title: Lifecycle & graceful shutdown
description: Serve a Kata app on Node and drain in-flight requests on SIGTERM with gracefulShutdown from kata/node.
---

# Lifecycle & graceful shutdown

A Kata app has no plugin lifecycle, no `onStart`/`onError` hooks, and no IoC
container to tear down. Singletons are eager: a factory like `singleton(makeDb(env))`
runs when `context.ts` is imported, and the value lives for the whole process.
There is one thing left to own — stopping the process *cleanly* when the
orchestrator asks. That is `gracefulShutdown` from `katajs/node`.

`createApp` does not touch the process. It installs no signal handlers, opens no
socket, and knows nothing about Node. Building an app is a side-effect-free
operation. Serving it, and shutting it down, is the job of `main.ts`.

## Serving the app

Kata does not ship an HTTP server. The app is a request handler — `app.fetch` —
and you hand it to a runtime adapter. On Node that adapter is
[`@hono/node-server`](https://github.com/honojs/node-server), a peer you install
yourself; its `serve()` owns the listening socket.

```ts
// src/main.ts
import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })
const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.resolve('logger').info(`listening on http://localhost:${info.port}`)
})
```

`createApp` returns a parametric Hono app; `app.fetch` is its `Request` →
`Response` handler. See the [create-app reference](/reference/create-app) for the
config it accepts.

## Why graceful shutdown

`serve()` returns a Node `Server` that owns the listening socket and every
in-flight connection. When the orchestrator stops your container — a `docker
stop`, a Kubernetes pod rotation, a systemd restart — it sends `SIGTERM`. If you
ignore it, Node's default handler terminates the process mid-flight: in-flight
requests are dropped and any pool you opened never closes. The next deploy
truncates live work.

The correct sequence is always the same: trap the signal once, stop accepting new
connections, let in-flight requests finish, run your teardown, and force-exit if a
connection hangs. Getting the drain order and the escape hatch right is fiddly and
identical across every app, so Kata owns it (ADR-0014).

## `gracefulShutdown`

`gracefulShutdown` lives in the **`katajs/node`** subpath — the only entry that
touches `node:process` — so importing the runtime-neutral core (`katajs`) from an
edge or Workers build never pulls Node in.

```ts
import { gracefulShutdown } from 'katajs/node'
import type { ServerType, GracefulShutdownOptions } from 'katajs/node'

function gracefulShutdown(server: ServerType, options: GracefulShutdownOptions): void

type GracefulShutdownOptions = {
  onClose: () => void | Promise<void>
  signals?: readonly NodeJS.Signals[] // default ['SIGTERM', 'SIGINT']
  timeoutMs?: number                  // default 10_000
}
```

It takes the **server**, not the app. The app is the request handler; the server
is the thing that owns the socket and must be `close()`d to drain. `ServerType` is
the handle `serve()` returns — a `node:http`/`http2` `Server` — re-derived from
`@types/node` so `katajs/node` needs only `@types/node` and never bundles the
adapter.

```ts
// src/main.ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'katajs/node'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })
const port = Number(process.env['PORT'] ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  k.resolve('logger').info(`listening on http://localhost:${info.port}`)
})

gracefulShutdown(server, {
  onClose: async () => {
    // App-owned teardown, in the app's chosen order. Resources are reached
    // through the registry or closed-over references.
    await k.resolve('db').close()
  },
  // signals: ['SIGTERM', 'SIGINT'], // default
  // timeoutMs: 10_000,              // default
})
```

## What it does on a signal

On the **first** trapped signal, `gracefulShutdown` runs, in order:

1. **Guards against re-entry.** A second `SIGTERM`/`SIGINT` while shutting down is
   ignored — the routine is idempotent and double-signal safe.
2. **Arms a force-exit timer.** `setTimeout(() => process.exit(1), timeoutMs)`,
   `.unref()`'d so the timer never keeps the event loop alive on its own.
3. **Stops accepting new connections.** `server.close()` — Node closes the
   listener and idle keep-alive sockets; **in-flight requests run to completion**.
4. **Awaits the in-flight drain** — the `server.close(callback)` completion, which
   fires once every open connection has finished.
5. **Runs `await onClose()`** — strictly *after* the drain, so no live handler
   loses its pool or transaction mid-query.
6. **Exits `0`** on clean completion within the budget.

If steps 4–5 exceed `timeoutMs`, the timer fires first and the process force-exits
**non-zero** — in-flight work was abandoned, a distinct and visible outcome for
the orchestrator, not a clean stop. If the drain or `onClose` throws, the process
also exits non-zero.

The signal listener stays registered across the shutdown, so a second signal is
caught and swallowed by the re-entry guard rather than hitting Node's default
terminating handler.

## `onClose`: your teardown, your order

Kata owns no dispose registry. There is no `dispose` hook on `singleton()` and
nothing walks the registry for you. `onClose` is the single place you sequence
teardown, and the order is yours — teardown is the inverse of construction and
domain-specific, which only the app knows:

```ts
gracefulShutdown(server, {
  onClose: async () => {
    await metrics.flush()   // flush buffered metrics first
    await queue.stop()      // then stop the queue consumer
    await k.resolve('db').close() // then close the pool, last
  },
})
```

Partial-failure policy is yours too: wrap a step in `try/catch` inside `onClose`
if you want to continue past a resource that fails to close. Anything `onClose`
forgets to close simply leaks on shutdown — the cost of not owning a registry.

::: warning Set `timeoutMs` below the orchestrator's grace period
`timeoutMs` (default 10 s) is a *soft* deadline that still lets you exit cleanly.
The orchestrator's is the *hard* one. Kubernetes' `terminationGracePeriodSeconds`
defaults to 30 s, after which it sends an uncatchable `SIGKILL`. Keep `timeoutMs`
under that window so you beat the `SIGKILL` and shut down on your own terms.
:::

## Signals

The default is `['SIGTERM', 'SIGINT']`:

- **`SIGTERM`** — the orchestrator's graceful-stop signal (`docker stop`,
  Kubernetes pod termination, systemd).
- **`SIGINT`** — Ctrl-C in a dev terminal, so local shutdown drains too.

`SIGKILL` and `SIGSTOP` are uncatchable by definition. `SIGHUP` (reload semantics
vary by deployment) is intentionally left to you. Override the set with `signals`
if you need a different trap.

::: info Opt in from `main.ts`
`createApp` installs no signal handlers. Registering `process.on` listeners as a
side effect of building an app would leak duplicate listeners across multiple apps
and test runs, couple the runtime-neutral core to `node:process`, and be wrong for
serverless or embedded hosts that never own the process. `main.ts` — the one place
the layout lets you talk to `process` — calls `gracefulShutdown` explicitly.
:::

## How it relates to `@hono/node-server`

`@hono/node-server` is the Node adapter: its `serve()` binds the socket and runs
`app.fetch` for each request. Kata adds nothing to that — it does not wrap or
re-export `serve()`. `gracefulShutdown` operates on the `Server` handle `serve()`
returns, calling its standard `close(callback)`. The two compose: `serve()` opens
the socket, `gracefulShutdown` drains and closes it.

## Other runtimes

`katajs/node` is Node-only and is v0.3's only lifecycle adapter. Edge and Workers
have no long-lived process to signal; Bun and Deno expose signals but differ on
server-close semantics. Cross-runtime lifecycle is deferred to the v0.4 milestone.
On those runtimes you serve the app the same way — hand `app.fetch` to the
runtime's own adapter — but you do not use `gracefulShutdown`.

## See also

- [create-app reference](/reference/create-app) — the app you serve and its config.
- [Context & DI](/guide/context-di) — eager singletons and the registry you reach
  through in `onClose`.
- [Database cookbook](/cookbook/database) — closing a connection pool on shutdown,
  end to end.
- [ADR-0014](/adr/0014-lifecycle-shutdown) — why teardown is a callback, not an
  auto-dispose registry.
