# Kata

> A web framework on Hono. Opinionated like NestJS, functional like a script,
> verifiable like a type system. Built so AI agents and humans both produce
> correct code on the first try.

Kata is a thin, opinionated layer over [Hono](https://hono.dev). It runs
anywhere Hono runs (Node, Bun, Deno, edge — [ADR-0001](docs/adr/0001-use-hono-as-base.md)),
it is **functional only** — no classes, no decorators, no runtime IoC container
([ADR-0002](docs/adr/0002-no-classes-no-decorators.md)) — and every route is
contract-complete: declared input and output schemas, validated at runtime.

## Status

Pre-release (`0.0.0`). The core — `defineContext`, `defineRoute`,
`defineMiddleware`, `createApp` — and a worked example ([`examples/hello`](examples/hello))
are in place. The `kata verify` lint harness is in progress. Decisions live in
[`docs/adr/`](docs/adr/).

## Thesis (TL;DR)

Three invariants make Kata mechanically verifiable in a Claude Code / Codex
`PostToolUse` hook in under 100ms:

1. **Static DI** — every dependency is declared in one `defineContext({...})`.
   No string-keyed lookups that escape the type system.
2. **Mandatory schemas** — every route declares input and output schemas.
   Lint fails if either is missing.
3. **Locked folder layout** — `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts`.
   No free-floating handlers.

These constraints power `kata verify`, which returns `hookSpecificOutput.additionalContext`
JSON for agent self-correction. See [ADR-0001](docs/adr/0001-use-hono-as-base.md)…
[ADR-0005](docs/adr/0005-dtos-in-separate-schema-file.md) for the full reasoning.

## Why another framework

| | Nest | Elysia | Hono + Zod template | Kata |
|---|---|---|---|---|
| Functional only | ❌ | ✅ | ✅ | ✅ |
| Runs on Hono (Node, Bun, Deno, Edge) | ❌ | ❌ (Bun) | ✅ | ✅ |
| Mandatory schemas (lint-enforced) | ❌ | ⚠️ | ❌ | ✅ |
| Statically enumerable DI | ❌ | ⚠️ | ❌ | ✅ |
| Harness hooks shipped natively | ❌ | ❌ | ❌ | ✅ |

## Install

Kata has two peer dependencies — Hono (the HTTP base) and Zod (schemas) — plus
Hono's Node adapter to boot a server on Node:

```bash
npm install kata hono zod @hono/node-server
# or: pnpm add kata hono zod @hono/node-server
```

> **Pre-release:** Kata is not yet published to npm. Today the fastest path is to
> clone this repo and run the worked example, which is what the walkthrough below
> builds:
>
> ```bash
> git clone https://github.com/VicenzoMF/kata.git
> cd kata && pnpm install
> pnpm --filter=hello dev      # boots examples/hello on http://localhost:3000
> ```

## Quickstart

A fully-typed `/users` API in six files. This is exactly
[`examples/hello`](examples/hello) — copy it verbatim into `src/`.

### 1. Declare every dependency once — `src/context.ts`

`defineContext` is the single place dependencies are registered ([ADR-0004](docs/adr/0004-di-via-scoped-slots.md)).
There are two kinds of slot:

- `singleton(value)` — lives for the process lifetime (db pool, logger, mailer).
- `scoped<T>()` — one value per request, populated by a middleware (current
  user, tenant id, request id).

`defineContext` returns `defineRoute`, `defineMiddleware`, and `createApp`
already bound to your registry. Re-export them so the rest of your app inherits
the types — `c.get('key')` only compiles for keys you registered here.

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

### 2. Schemas (DTOs) — `src/modules/users/users.schema.ts`

Every domain's Zod schemas live in `<domain>.schema.ts`, never inline in the
route ([ADR-0005](docs/adr/0005-dtos-in-separate-schema-file.md)). Export the
`z.infer` types alongside them so a single import pulls both the runtime and the
compile-time contract.

```ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

export type User = z.infer<typeof UserSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

### 3. Business logic — `src/modules/users/users.service.ts`

Services are plain, pure functions — trivial to unit-test, no framework imports.

```ts
import type { CreateUserBody, User } from './users.schema'

const store = new Map<string, User>()

export async function getUser(id: string): Promise<User | null> {
  return store.get(id) ?? null
}

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  store.set(id, user)
  return user
}
```

### 4. Middleware & scoped slots — `src/middlewares/auth.ts`

A middleware declares which scoped slots it `provides`, then populates them with
`c.set(...)`. Returning a `Response` (e.g. `c.json(..., 401)`) short-circuits the
request before the handler runs.

```ts
import { defineMiddleware } from '../context'

/**
 * Toy auth: reads `x-user-id` header and synthesizes a User.
 * Replace with real JWT / session decoding in any real app.
 */
export const fakeAuth = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const userId = c.header('x-user-id')
    if (!userId) return c.json({ error: 'unauthorized' }, 401)

    c.set('currentUser', {
      id: userId,
      name: `User-${userId}`,
      email: `user-${userId}@example.test`,
    })
    await next()
  },
})
```

### 5. Routes — `src/modules/users/users.route.ts`

Every route declares mandatory `input` and `output` schemas
([ADR-0003](docs/adr/0003-mandatory-input-output-schemas.md)) — omitting either
is a TypeScript error. Inside the handler, `c.input` is fully typed from the
input schemas, and a handler may either **return a value** (validated against
`output`, then serialized) or **return `c.json(...)`** to short-circuit with a
custom status. Routes that read a scoped slot list the providing middleware in
`use:`.

```ts
import { z } from 'zod'

import { defineRoute } from '../../context'
import { fakeAuth } from '../../middlewares/auth'

import { CreateUserBodySchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.json({ error: 'not_found' }, 404)
    return user
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [fakeAuth],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
```

### 6. Boot it — `src/main.ts`

`createApp({ modules })` wires every exported route in each module into a Hono
app. A module is just the namespace import of a `.route.ts` file. Hand
`app.fetch` to `@hono/node-server` to listen.

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

## Run it

From this repo, the example is wired with [`tsx`](https://tsx.is):

```bash
pnpm --filter=hello dev      # tsx watch src/main.ts → http://localhost:3000
```

In a standalone project, add `tsx` (`npm i -D tsx`) and run `tsx watch src/main.ts`.

Then hit it with `curl`:

```bash
# Create a user (valid body) → 200, validated against UserSchema
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com"}'
# {"id":"f81d4fae-…","name":"Ada","email":"ada@example.com"}

# Fetch it back by id → 200
curl -s localhost:3000/users/f81d4fae-…

# Unknown id → 404 (your handler's c.json — not Kata)
curl -s localhost:3000/users/none
# {"error":"not_found"}

# Scoped slot populated by middleware
curl -s localhost:3000/me                      # 401 {"error":"unauthorized"}
curl -s localhost:3000/me -H 'x-user-id: 42'   # 200 {"id":"42","name":"User-42",…}
```

## When validation fails — the 422 envelope

Kata validates `input` **before** your handler runs. On failure it responds
`422` with a normalised envelope: `error: "validation_failed"` plus `issues`
keyed by the input section that failed (`params`, `query`, `body`, or `headers`),
each an array of field issues.

```bash
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"name":"","email":"not-an-email"}'
```

```json
{
  "error": "validation_failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "String must contain at least 1 character(s)" },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Each field issue is `{ path, message, code }`, with optional `expected` /
`received` added for type mismatches. `path` uses dot/bracket notation for
nested fields (e.g. `address.zip`, `tags[0]`).

Output is validated too, **after** the handler returns ([ADR-0003](docs/adr/0003-mandatory-input-output-schemas.md)).
If a handler returns a value that does not match its `output` schema, Kata
responds `500 {"error":"internal_output_shape_mismatch"}` and logs the offending
Zod issues server-side — the wrong shape never reaches the client.

## Project layout

Kata locks the folder layout so every route, service, schema, and test is
findable by glob. The canonical layout (full list in [`AGENTS.md`](AGENTS.md)):

```
src/
├── app.ts                # createApp({ context, modules })
├── context.ts            # defineContext({ ... })
├── middlewares/
└── modules/<domain>/
    ├── <domain>.route.ts     # defineRoute calls only
    ├── <domain>.service.ts   # pure functions
    ├── <domain>.schema.ts    # Zod schemas (DTOs)
    ├── <domain>.hurl         # API E2E
    └── <domain>.test.ts      # unit tests
```

[`examples/hello`](examples/hello) is a minimal instance of this layout (it
folds `app.ts` into `main.ts`).

## Architecture decisions

Every architectural decision is an ADR under [`docs/adr/`](docs/adr/). Read the
relevant one before deviating.

- [ADR-0001](docs/adr/0001-use-hono-as-base.md) — Use Hono as the HTTP base.
- [ADR-0002](docs/adr/0002-no-classes-no-decorators.md) — Fully functional API; no classes, no decorators.
- [ADR-0003](docs/adr/0003-mandatory-input-output-schemas.md) — Every route declares input and output schemas.
- [ADR-0004](docs/adr/0004-di-via-scoped-slots.md) — DI via a registry of singletons and scoped slots.
- [ADR-0005](docs/adr/0005-dtos-in-separate-schema-file.md) — DTOs live in `<domain>.schema.ts`.
- [ADR-0006](docs/adr/0006-issue-tracking-via-milestones-epics-sub-issues.md) — Issue tracking via milestones, epics, sub-issues.
- [ADR-0007](docs/adr/0007-self-apply-harness-before-feature-work.md) — Self-apply the harness before feature work.

## License

TBD (will be open-source).
