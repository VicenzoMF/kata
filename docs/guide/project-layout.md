---
title: Project layout
description: The locked src/ tree, why every file is findable by suffix, and how the layout powers kata verify.
---

# Project layout

Kata locks the folder layout. Every route, service, schema, and test lives at a path
you can predict from its domain name — nothing floats, and nothing is wired together by
a config file. This is convention-over-configuration taken literally: a file's name and
location are *data* the tooling reads, not just tidiness for humans. The layout is the
contract `kata verify` checks, and the reason an agent — or you — can find the file it
needs without searching.

## The tree

```
src/
├── app.ts                    # createApp({ modules, middlewares? })  — optional
├── context.ts                # defineContext({ ... }) — the DI registry
├── main.ts                   # boot: serve(app.fetch, ...)
├── middlewares/              # cross-cutting middleware (auth, tx, ...)
└── modules/
    └── <domain>/
        ├── <domain>.route.ts     # defineRoute calls only
        ├── <domain>.service.ts   # pure functions
        ├── <domain>.schema.ts    # Zod schemas (DTOs)
        ├── <domain>.hurl         # API E2E (Hurl)
        └── <domain>.test.ts      # unit tests
```

`context.ts` is special. It holds your one `defineContext({...})` call and re-exports
`defineRoute`, `defineMiddleware`, and `createApp` already bound to the registry. The
verify harness reads *this exact file* to learn which keys `c.get(...)` may use — so it
has to be `src/context.ts`, not renamed and not split. Move it and the DI checks have
nothing to read.

A domain is a folder under `src/modules/`. Its files share the domain prefix: the
`users` domain is `users.route.ts`, `users.service.ts`, `users.schema.ts`, and so on.
One folder, one prefix, no exceptions.

## Why findability matters

Here is the load-bearing idea: **the suffix is the type of the file.** A file named
`users.route.ts` contains route declarations; `users.schema.ts` contains Zod DTOs;
`users.service.ts` contains pure functions. Because the suffix carries that meaning,
both tooling and people can locate any file from its name alone:

```bash
# every route in the app
ls src/modules/*/*.route.ts

# every DTO
ls src/modules/*/*.schema.ts

# the service for one domain
cat src/modules/users/users.service.ts
```

`kata verify` walks `src/` and dispatches rules by suffix — no glob library, no config.
The walk skips the `node_modules`, `dist`, `build`, `coverage`, `data`, and `.git`
directories, and drops `*.test.ts`, `*.d.ts`, and `*.schema.ts` files before any rule
runs. Each remaining file is routed by its name:

- `*.route.ts` → checked for mandatory `input` / `output`, inline schemas, and
  unregistered or unprovided context keys.
- `*.service.ts` → checked for inline schemas (a service is the other place a stray
  `z.object(...)` is rejected).
- `*.schema.ts` → the one place a Zod schema may live, so it is excluded from the walk;
  no rule reads it.

If you inline a schema in a `.route.ts`, or put a route in a misnamed file, the checks
key off the wrong suffix and the harness reports it. The layout is what makes the rules
cheap and exact. See [The harness](/guide/harness) for the full rule set.

::: warning One prefix per file
`users.route.ts` is correct. `routes/users.ts`, `user-routes.ts`, or a
`UsersController` are not — the suffix carries the meaning, and the harness matches on
it. Renaming `context.ts` breaks DI checks the same way.
:::

## `app.ts` vs. folding it into `main.ts`

`app.ts` builds the application — one `createApp({ modules, middlewares? })` call — and
exports it. `main.ts` is the runtime entrypoint: it imports the app and hands
`app.fetch` to a server.

```ts
// src/app.ts
import { createApp } from './context'
import * as users from './modules/users/users.route'

export const app = createApp({ modules: [users] })
export type AppType = typeof app // the type your RPC client imports
```

```ts
// src/main.ts
import { serve } from '@hono/node-server'

import { app } from './app'
import { k } from './context'

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

Why split them? Because it keeps the app constructible in isolation — your tests and the
[typed RPC client](/guide/rpc-client) import `AppType` from `app.ts` without booting a
server, while `main.ts` stays a thin boot script that owns the socket.

For a small service you may **fold `app.ts` into `main.ts`** — call `createApp` inline
and serve it in one file. Both worked examples do exactly this:

```ts
// src/main.ts — examples/hello
import { serve } from '@hono/node-server'
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp, k } from './context'
import * as auth from './modules/auth/auth.route'
import * as diag from './modules/diag/diag.route'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users, auth, echo, diag],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

`app.ts` is the only optional file in the tree. Splitting is the right default once you
have an RPC client or want the app importable from tests; the fold is fine while the app
is one file. `context.ts` and the module files are never optional.

## Inside a module

Each `<domain>/` folder is self-contained, with one responsibility per file:

- **`<domain>.schema.ts`** — Zod schemas and their inferred types. DTOs live here and
  nowhere else ([`defineRoute`](/reference/define-route), ADR-0005). A route imports its
  `input` / `output` schemas from this file.
- **`<domain>.service.ts`** — [pure functions](/guide/services). No framework imports,
  no `c`. Trivial to unit-test in isolation.
- **`<domain>.route.ts`** — `defineRoute` calls only. The handler validates `c.input`,
  calls services, and returns a value (checked against `output`) or `c.json(...)` /
  `c.error(...)`. See [Routes & schemas](/guide/routes-schemas).
- **`<domain>.test.ts`** — unit tests, typically over the service.
- **`<domain>.hurl`** — [Hurl](https://hurl.dev) requests that exercise the live HTTP
  surface end to end.

A real domain from `examples/hello`:

```
src/modules/users/
├── users.route.ts
├── users.schema.ts
├── users.service.ts
├── users.service.test.ts
└── users.hurl
```

::: tip Cross-cutting middleware
Middleware that more than one domain uses — JWT auth, a transaction slot — belongs in
`src/middlewares/`, not inside a module. Each declares the scoped slots it `provides`;
see [Middleware](/guide/middleware) and [App-level middleware](/guide/app-middleware).
Shared non-HTTP infrastructure (a `store.ts`, a connection pool) sits at the `src/`
root, as in `examples/shop`.
:::

## Scaffolding

`kata init --with-example` writes the locked layout for you — `src/context.ts`,
`src/main.ts`, and a `src/modules/health/` domain with its `health.route.ts` and
`health.schema.ts` — so a new project starts in the shape the harness expects. See
[Bootstrap CLI](/guide/cli).
