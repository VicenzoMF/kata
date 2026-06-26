---
title: Cookbook
description: Real-world Kata recipes — auth, database, errors, NestJS migration, and the BYO boundary.
---

# Cookbook

Real-world recipes that don't fit in the [quickstart](/guide/quickstart). Each
recipe solves one common problem with copy-pasteable code that mirrors the
runnable example apps — [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello)
(minimal) and [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop)
(scoped transactions, query filtering).

## Recipes

| Recipe | Problem it solves |
| --- | --- |
| [Authentication & authorization](/cookbook/auth) | Identify the caller and expose them to handlers via a scoped slot, then authorize routes by role or claim. |
| [Database access](/cookbook/database) | Share a long-lived client (db, cache, mailer) across handlers via a singleton slot, and a pure-service layer you can unit-test. |
| [Errors & validation](/cookbook/errors) | Return correct 4xx responses and understand Kata's automatic 422 / 500 envelopes. |
| [Migrating from NestJS](/cookbook/migrating-from-nestjs) | Map every NestJS building block — controllers, providers, guards, pipes, DTOs — to its functional Kata equivalent. |
| [Non-goals & BYO](/cookbook/non-goals) | See what Kata deliberately leaves to you — persistence, rate limiting, metrics, env, pagination — and the idiomatic bring-your-own pattern for each. |

## How these recipes are grounded

Every snippet is checked against the actual framework surface, not paraphrased
from memory:

- The exported core API lives in
  [`packages/kata/src/index.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/index.ts);
  auth helpers under [`katajs/jwt`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/jwt/index.ts).
- Runnable reference apps live in
  [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello)
  and [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop).

If a recipe shows an API, that API exists today. Where a recipe leans on
something planned but not shipped, it is labelled _Planned_ and links to the
tracking issue — never assume planned API works yet.

## The shared context

Every recipe builds on one file. Kata centralises dependency injection in a
single `defineContext({...})` call (see [Context & DI](/guide/context-di) and
[ADR-0004](/adr/0004-di-via-scoped-slots)), and the `defineRoute` /
`defineMiddleware` / `createApp` helpers it returns are bound to that context.
The idiomatic setup re-exports them so the rest of the app imports from
`./context`, never from `katajs` directly:

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

export const k = defineContext({
  // singletons — one instance for the whole process (see /cookbook/database)
  db: singleton(makeDb(process.env)),
  // scoped slots — one value per request, set by a middleware (see /cookbook/auth)
  currentUser: scoped<User>(),
})

// Bind the helpers to this context, then import them everywhere else.
export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

```ts
// src/main.ts
import { serve } from '@hono/node-server'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })
```

Each `module` passed to `createApp` is a `*.route.ts` file imported with
`import * as`; Kata registers every route it exports. See
[App & createApp](/reference/create-app) for the full signature.

## Conventions every recipe follows

These are enforced project-wide — the snippets obey them so you can paste them in:

- **Functional only** — no classes, no decorators ([ADR-0002](/adr/0002-no-classes-no-decorators)).
- **Named exports only** — no default exports.
- **No `any`** — use `unknown` plus narrowing.
- **Schemas live in `<domain>.schema.ts`**, never inline in a route ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).
- **Every route declares `input` and `output` schemas** ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).
- **DI goes through `c.get('key')`**, where `'key'` must be registered in
  `defineContext` ([ADR-0004](/adr/0004-di-via-scoped-slots)).

::: tip Read the reference alongside the recipes
The cookbook is task-first. For the exhaustive signature of each helper, see the
[reference](/reference/): [`defineContext`](/reference/define-context),
[`defineRoute`](/reference/define-route),
[`defineMiddleware`](/reference/define-middleware),
[`createApp`](/reference/create-app), the
[built-in middleware](/reference/middleware), and [`katajs/jwt`](/reference/jwt).
:::

## See also

- [What is Kata](/guide/what-is-kata) and [Why Kata](/guide/why-kata) — the thesis behind the constraints.
- [Project layout](/guide/project-layout) — the locked `modules/<domain>/` structure every recipe assumes.
- [RPC client](/guide/rpc-client) — the typed `hc<AppType>` client these schemas power end to end.
