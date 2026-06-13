# Kata Cookbook

Real-world recipes that don't fit in the [README](../../README.md). Each recipe
solves one common problem with copy-pasteable code that mirrors the working
[`examples/hello`](../../examples/hello) app.

## Recipes

| Recipe | Problem it solves |
|---|---|
| [Authentication](./auth.md) | Identify the caller and expose them to handlers via a scoped slot. |
| [Database access](./database.md) | Share a long-lived client (db, cache, mailer) across handlers via a singleton slot. |
| [Errors & validation](./errors.md) | Return correct 4xx responses and understand Kata's 422 / 500 envelopes. |

## How these recipes are grounded

Every snippet is checked against the actual framework surface:

- The exported API lives in [`packages/kata/src/index.ts`](../../packages/kata/src/index.ts).
- A runnable reference app lives in [`examples/hello`](../../examples/hello).

If a recipe shows an API, that API exists today. Where a recipe mentions something
that is **planned but not shipped**, it is labelled _Planned_ and links to the
tracking issue — never assume planned API works yet.

## The shared context

All three recipes build on one file. Kata centralises dependency injection in a
single `defineContext({...})` call (ADR-0004), and the
`defineRoute` / `defineMiddleware` / `createApp` helpers it returns are bound to
that context. The idiomatic setup re-exports them so the rest of the app imports
from `./context`, never from `kata` directly:

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'kata'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

export const k = defineContext({
  // singletons — one instance for the whole process (see database.md)
  db: singleton(makeDb(process.env)),
  // scoped slots — one value per request, set by a middleware (see auth.md)
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
`import * as`; Kata registers every exported route in it.

## Conventions every recipe follows

These are enforced project-wide — the snippets obey them so you can paste them in:

- **Functional only** — no classes, no decorators ([ADR-0002](../adr/0002-no-classes-no-decorators.md)).
- **Named exports only** — no default exports.
- **No `any`** — use `unknown` plus narrowing.
- **Schemas live in `<domain>.schema.ts`**, never inline in a route ([ADR-0005](../adr/0005-dtos-in-separate-schema-file.md)).
- **Every route declares `input` and `output` schemas** ([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)).
- **DI goes through `c.get('key')`**, where `'key'` must be registered in
  `defineContext` ([ADR-0004](../adr/0004-di-via-scoped-slots.md)).

## Planned API referenced in this cookbook

Every API these recipes reference is now shipped — there is no roadmap-only
surface in this cookbook at the moment.

> **Recently shipped** — now documented as available API in these recipes: the
> unified `c.error` helper + error envelope
> ([#18](https://github.com/VicenzoMF/kata/issues/18),
> [ADR-0008](../adr/0008-unified-error-response-envelope.md)), the global error
> boundary ([#62](https://github.com/VicenzoMF/kata/issues/62)),
> output-validation mode ([#17](https://github.com/VicenzoMF/kata/issues/17),
> [ADR-0009](../adr/0009-output-validation-mode.md)), and multi-status output
> schemas ([#19](https://github.com/VicenzoMF/kata/issues/19),
> [ADR-0011](../adr/0011-multi-status-output-schemas.md)).

## See also

- [README usage walkthrough](../../README.md) — shipped (#33)
- [Migrating from NestJS to Kata](./migrating-from-nestjs.md) — shipped (#34)
- [Multi-domain e-commerce example](../../examples/shop) — shipped (#36)
- [RPC client — typed `hc<typeof app>`, end to end](../../examples/hello-client) — shipped (#15)
