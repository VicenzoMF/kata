# Recipe: Database access

**Problem:** open a database connection (or any long-lived client — cache,
mailer, queue) once, and reach it from any handler without re-creating it per
request or reaching for a module-level global.

**Pattern:** a **singleton slot** in `defineContext`. Per
[ADR-0004](../adr/0004-di-via-scoped-slots.md), singletons live for the process
lifetime; `c.get('db')` returns the same instance on every request, synchronously
and fully typed.

## 1. Define a typed client

Kata is functional — no classes, no decorators ([ADR-0002](../adr/0002-no-classes-no-decorators.md)).
Model the client as an interface plus a factory function. Keep the surface small
and concrete; `any` is banned.

```ts
// src/db.ts
import type { User } from './modules/users/users.schema'

export type Db = {
  findUser: (id: string) => Promise<User | null>
  insertUser: (user: User) => Promise<void>
}

export function makeDb(env: NodeJS.ProcessEnv): Db {
  // Swap this in-memory store for your real driver (node-postgres, Drizzle,
  // Prisma, …). `env` is read once, here — not inside handlers.
  void env
  const store = new Map<string, User>()
  return {
    findUser: async (id) => store.get(id) ?? null,
    insertUser: async (user) => {
      store.set(user.id, user)
    },
  }
}
```

## 2. Register it as a singleton

`singleton(value)` wraps a ready-to-use instance. The factory runs when the
module that defines the context is first evaluated, so the connection is
established once at startup.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'kata'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

export const k = defineContext({
  db: singleton(makeDb(process.env)),
  currentUser: scoped<User>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

## 3. Read it in a handler, pass it to a pure service

Resolve the client in the route handler with `c.get('db')`, then hand it to a
service function. Keeping the service **pure** — it receives `db` as an argument
rather than importing the context — is what makes it unit-testable without
booting an HTTP server (the layout in
[`examples/hello`](../../examples/hello) keeps services free of framework
imports for exactly this reason).

```ts
// src/modules/users/users.service.ts
import type { Db } from '../../db'
import type { CreateUserBody, User } from './users.schema'

export async function findUser(db: Db, id: string): Promise<User | null> {
  return db.findUser(id)
}

export async function createUser(db: Db, input: CreateUserBody): Promise<User> {
  const user: User = { id: crypto.randomUUID(), ...input }
  await db.insertUser(user)
  return user
}
```

```ts
// src/modules/users/users.schema.ts  (add the params schema here, never inline)
export const UserIdParamSchema = z.object({ id: z.string() })
```

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'

import { CreateUserBodySchema, UserIdParamSchema, UserSchema } from './users.schema'
import { createUser, findUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: UserIdParamSchema },
  output: UserSchema,
  handler: async (c) => {
    const user = await findUser(c.get('db'), c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.get('db'), c.input.body),
})
```

> Schemas are imported from `users.schema.ts`, never written inline in a route
> ([ADR-0005](../adr/0005-dtos-in-separate-schema-file.md)).

## 4. Test the service with a fake client

Because the service takes `db` as a parameter, a unit test passes a hand-rolled
fake — no network, no context, no Hono. This mirrors
[`users.service.test.ts`](../../examples/hello/src/modules/users/users.service.test.ts).

```ts
// src/modules/users/users.service.test.ts
import { describe, expect, it } from 'vitest'

import type { Db } from '../../db'
import { findUser } from './users.service'

const fakeDb: Db = {
  findUser: async (id) => (id === '1' ? { id: '1', name: 'Ada', email: 'ada@example.com' } : null),
  insertUser: async () => {},
}

describe('users.service', () => {
  it('findUser returns null for unknown ids', async () => {
    expect(await findUser(fakeDb, 'nope')).toBeNull()
  })
})
```

## Why singleton, not scoped

| | `singleton(value)` | `scoped<T>()` |
|---|---|---|
| Lifetime | whole process | one HTTP request |
| Created | once, at `defineContext` | by a middleware, per request |
| `c.get` returns | the same instance every time | the value the middleware `set` |
| Use for | db / cache / logger / mailer | current user / tenant / request id / active tx |

`c.get('db')` is monomorphic — always `Db`, never `Promise<Db>` or
`Db | undefined` — which is the inference property ADR-0004 was chosen to
preserve.

## Per-request DB state (transactions)

A connection pool is a singleton, but a transaction is per-request — so it's a
**scoped** slot, opened and committed by a middleware:

```ts
// context.ts:  tx: scoped<Transaction>()
export const withTransaction = defineMiddleware({
  provides: ['tx'] as const,
  handler: async (c, next) => {
    const tx = await c.get('db').begin()
    c.set('tx', tx)
    await next() // commit/rollback wiring lives here; see the note below
  },
})
```

Robust commit-on-success / rollback-on-failure depends on the middleware seeing
the handler's outcome — and the global error boundary
([#62](https://github.com/VicenzoMF/kata/issues/62)) makes that outcome visible:
wrap `await next()` in `try/catch` to roll back (and rethrow) on a throw, and
roll back any transaction the handler left un-committed. The
[`examples/shop` transaction middleware](../../examples/shop/src/middlewares/transaction.ts)
shows the full pattern.

## Gotchas

- **Singletons are eager.** `makeDb(process.env)` runs when `context.ts` is first
  imported, not lazily on first `c.get`. Do connection setup there; do not put
  request-specific logic in the factory.
- **Lifecycle is outside the request.** Closing the pool on shutdown belongs in
  the server bootstrap (`main.ts`) via process signals — Kata has no per-request
  teardown hook for singletons.
- **Read config at the edge.** Pass `env` into `makeDb` once; keep
  `process.env` out of handlers and services so they stay pure and testable.
- **`c.get('db')` only compiles if `'db'` is in `defineContext`.** An unregistered
  key is both a type error and a runtime throw (`kata: key 'db' not registered in
  defineContext`) — and the `kata/context-key-not-registered` lint rule flags it too.
