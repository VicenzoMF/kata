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
are in place, including **end-to-end typed RPC clients** (`hc<typeof app>`, with a
runnable [`examples/hello-client`](examples/hello-client)). The `kata verify` lint
harness is in progress. Decisions live in [`docs/adr/`](docs/adr/).

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
npm install katajs hono zod @hono/node-server
# or: pnpm add katajs hono zod @hono/node-server
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

A middleware declares which scoped slots it `provides`; its handler fills them —
directly with `c.set(...)`, or via a built-in. Returning a `Response`
short-circuits the request before the handler runs.

Kata ships JWT auth under [`katajs/jwt`](docs/adr/0013-jwt-delivery.md): `jwtAuth`
reads a `Bearer` token, verifies it, parses the claims with your Zod schema, and
fills the slot. The `resolve()` hook maps the validated claims onto the app's
`User`. You keep the `defineMiddleware` wrapper, so the `provides` literal stays
greppable and lint-checkable.

```ts
import { jwtAuth } from 'katajs/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

To roll your own slot-filling middleware with `c.set` directly (sessions, API
keys), or to layer authorization with `requireRole` / `guard`, see the
[auth cookbook](docs/cookbook/auth.md).

### 5. Routes — `src/modules/users/users.route.ts`

Every route declares mandatory `input` and `output` schemas
([ADR-0003](docs/adr/0003-mandatory-input-output-schemas.md)) — omitting either
is a TypeScript error. Inside the handler, `c.input` is fully typed from the
input schemas, and a handler may either **return a value** (validated against
`output`, then serialized) or **return `c.json(...)` / `c.error(...)`** to set a
custom status. `output` may be a single schema (the 200 body) or a status→schema
map — `{ 200: UserSchema, 404: ErrorBodySchema }` — that types and validates each
status ([ADR-0011](docs/adr/0011-multi-status-output-schemas.md)). Routes that
read a scoped slot list the providing middleware in `use:`.

```ts
import { z } from 'zod'

import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

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
  use: [requireUser],
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

**Harden it app-wide.** Cross-cutting middleware goes in the same `createApp` call
through the optional `middlewares` slot — a chain that runs **before** every route's
own `use:` ([ADR-0012](docs/adr/0012-app-level-middleware.md)). The first-party
hardening built-ins — `cors()`, `secureHeaders()`, and `bodyLimit()` — are the
canonical case: declare them once and every route is covered, instead of
copy-pasting them onto each `defineRoute`.

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'

const app = createApp({
  modules: [users],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

[`examples/hello`](examples/hello/src/main.ts) wires exactly this trio app-wide. For
full CORS preflight (`OPTIONS`) handling, apply `cors()` on the returned app via
`app.use('*', …)` — see the note in [`cors.ts`](packages/kata/src/middlewares/cors.ts).

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

# Auth: mint a token (POST /auth/token), then call /me with it.
curl -s localhost:3000/auth/token -H 'content-type: application/json' \
  -d '{"id":"42","name":"Ada","email":"ada@example.com"}'
# {"token":"eyJhbGc…"}

curl -s localhost:3000/me                                       # 401 {"error":"unauthorized",…}
curl -s localhost:3000/me -H 'Authorization: Bearer eyJhbGc…'  # 200 {"id":"42","name":"Ada",…}
```

## Typed RPC client — `hc<typeof app>`

`createApp` returns a **parametric** Hono app whose type carries every route, so
Hono's [RPC client](https://hono.dev/docs/guides/rpc) infers paths, request
bodies, and responses straight from your Zod schemas — **no codegen, no shared
runtime**. The server exports one type:

```ts
// server side — createApp derives the route schema; export the app's type
export const app = createApp({ modules: [users] })
export type AppType = typeof app // ≡ KataApp<[typeof users]>
```

A client imports **only that type** and is fully typed end to end:

```ts
import { hc } from 'hono/client'
import type { AppType } from 'server' // the only thing the client needs

const client = hc<AppType>('http://localhost:3000')

const res = await client.users.$post({ json: { name: 'Ada', email: 'ada@x.io' } })
const user = await res.json() // { id: string; name: string; email: string }

await client.users.$post({ json: { name: 'no-email' } }) // ✗ compile error
```

The DI registry never reaches the wire, so the client's Hono `Env` stays
`BlankEnv`. [`examples/hello-client`](examples/hello-client) is a runnable,
type-checked demonstration (its compile-time proofs run in CI).

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

[Apache License 2.0](LICENSE) © 2026 Vicenzo Frusciante.

Kata is open source. You're free to use, modify, and distribute it — including
in commercial and closed-source products — provided you keep the copyright and
attribution notices (see [`NOTICE`](NOTICE)). Apache-2.0 also includes an
express patent grant and does **not** grant rights to the "Kata" name or
trademarks.
