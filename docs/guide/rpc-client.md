---
title: Typed RPC client
description: How createApp returns a parametric Hono app whose type gives the hc client end-to-end types from your Zod schemas — no codegen, no shared runtime.
---

# Typed RPC client

First, the term. An **RPC client** (remote procedure call) lets you call a server
endpoint as if it were a local function — `client.users.$post(...)` instead of
hand-writing a `fetch` with a URL, a method, headers, and `JSON.stringify`. "Typed"
means that function already knows the server's *exact* input and output types: the
arguments it accepts and the shape it returns are the very Zod schemas the server
validates against.

A Kata server already declares every route's `input` and `output` as Zod schemas. The
RPC client reuses those declarations — it infers paths, request bodies, params, query,
and per-status responses straight from the same schemas the server validates against.
**No codegen. No shared runtime.** The only artifact a client imports is one exported
*type*.

That last point is what "end-to-end types" really means: because the contract travels
as a type rather than a generated file, there is nothing to regenerate and nothing to
drift. Rename a field on the server and every client call site that used it stops
compiling — the mismatch becomes a build error instead of a production 500.

This is Hono's [RPC client](https://hono.dev/docs/guides/rpc). Kata's job is to make
`createApp` return a Hono app whose *type* carries your routes, so `hc` has something to
infer from.

## The app type

`createApp` returns a **parametric** `Hono` app — "parametric" meaning its type is
parameterised by the modules you pass in, so the routes you registered are visible *in
the type itself*. Its RPC schema is derived from those modules. Export that app's type
and you have handed a client the entire contract:

```ts
// server.ts
import { createApp } from './context'
import * as users from './modules/users/users.route'

const modules = [users] as const

export const app = createApp({ modules })

// The only thing a client imports.
export type AppType = typeof app
```

`createApp` infers its module tuple with a `const` type parameter, so the `as const` on
`modules` is what keeps the element types literal — without it, TypeScript would widen
them and the per-route detail would be lost. `AppType` is exactly
`KataApp<typeof modules>` — the same type spelled two ways.

::: tip
`KataApp` is exported from `kata` if you want to name the type explicitly:

```ts
import type { KataApp } from 'kata'

export type Modules = typeof modules
export type AppType = KataApp<Modules> // ≡ typeof app
```

You rarely need this — `typeof app` is enough.
:::

## The client

A client imports **only** `AppType` and passes it to `hc`:

```ts
// client.ts
import { hc } from 'hono/client'

import type { AppType } from './server' // in a real deploy: from the server package

const client = hc<AppType>('http://localhost:3001')
```

In a real deployment the server lives in one package and the client in another — a
frontend, a microservice, a CLI. The only thing they share is the `AppType` import, and
since a type is erased at build time, the client carries no runtime dependency on the
server and there is no generated client to keep in sync.

## Calling routes

The client mirrors your route tree: each path segment becomes a property, and each HTTP
method becomes a `$`-prefixed call (`$get`, `$post`). The request inputs you declared
under `input` map onto Hono's client targets like this:

| Kata `input` key | Client target |
| --- | --- |
| `body` | `json` |
| `params` | `param` |
| `query` | `query` |
| `headers` | `header` |

A path param like `/users/:id` is reached through its literal segment,
`client.users[':id']`.

```ts
// POST /users — body inferred from CreateUserBodySchema
const created = await client.users.$post({ json: { name: 'Ada', email: 'ada@example.com' } })
const user = await created.json() // { id: string; name: string; email: string }

// GET /users/:id — param inferred from GetUserParamsSchema
const fetched = await client.users[':id'].$get({ param: { id: user.id } })

// GET /users?q=… — query inferred from ListUsersQuerySchema
const all = await client.users.$get({ query: { q: 'grace' } })
const list = await all.json() // { id: string; name: string; email: string }[]
```

Request types are derived from `z.input` — the shape the caller sends, before any Zod
transforms. Response types are derived from `z.infer` — the shape after parsing.

## Wrong calls are compile errors

Because inputs come from your schemas, a call that violates them does not type-check.
These three statements each fail `tsc`:

```ts
// Body must satisfy CreateUserBodySchema — email is required.
await client.users.$post({ json: { name: 'no-email' } }) // ✗

// Path param `id` is a string, not a number.
await client.users[':id'].$get({ param: { id: 123 } }) // ✗

// Query `q` is a string, not a number.
await client.users.$get({ query: { q: 123 } }) // ✗
```

You do not get a runtime surprise. You get a red squiggle in the editor and a failing
typecheck in CI.

## Multi-status responses narrow on `res.status`

When a route declares a status→schema `output` map (see
[Routes & schemas](/guide/routes-schemas)), the response is a per-status union. Narrow
it with `res.status`, and each branch is typed to that status's schema.

The `/users/:id` route declares `output: { 200: UserSchema, 404: ErrorBodySchema }`:

```ts
const res = await client.users[':id'].$get({ param: { id } })

if (res.status === 404) {
  const { error, message } = await res.json() // the error envelope: { error, message, issues? }
  return { notFound: true as const, error, message }
}

return res.json() // { id: string; name: string; email: string }
```

`ErrorBodySchema` (exported from `kata`) is the canonical schema for Kata's error
envelope, so the 404 branch is typed end to end. See [Errors](/guide/errors) for the
envelope shape and `c.error(...)`.

## Extracting the types directly

If you need the inferred request or response type for a call site — to type a function
parameter or a React hook — use Hono's `InferRequestType` and `InferResponseType`:

```ts
import type { InferRequestType, InferResponseType } from 'hono'

type CreateUserBody = InferRequestType<typeof client.users.$post>['json']
// { name: string; email: string }

type UserResponse = InferResponseType<(typeof client.users)[':id']['$get'], 200>
// { id: string; name: string; email: string }

type NotFoundResponse = InferResponseType<(typeof client.users)[':id']['$get'], 404>
// the error envelope, narrowed to the 404 status
```

The second argument to `InferResponseType` is the status you are narrowing to — the
same status you branch on at runtime.

## The DI registry never reaches the wire

A server registers dependencies in `defineContext` — a logger, a db pool, scoped slots
like `currentUser` (see [Context & DI](/guide/context-di)). None of that is part of the
HTTP contract, so none of it appears in the client type — which is exactly what you
want: a database handle and your internal services are server-only concerns, and they
have no business leaking into a frontend's types. The client's Hono `Env` stays
`BlankEnv`.

```ts
import type { Hono } from 'hono'
import type { BlankEnv } from 'hono/types'

type EnvOf<T> = T extends Hono<infer E, infer _S, infer _B> ? E : never

// Holds — DI is server-only.
type _Proof = EnvOf<AppType> extends BlankEnv ? true : false
```

So `c.get('logger')` works inside a handler but is invisible to `hc<AppType>`. The wire
carries routes, inputs, and outputs — never your registry.

## Testing the client in-process

`hono/testing`'s `testClient` binds `hc<typeof app>` to your app object directly, with
no socket. The calls drive the full Kata pipeline — input validation, handler, output
validation — with the exact types the real client sees, so your tests and your type
layer cannot drift apart.

```ts
import { testClient } from 'hono/testing'
import { describe, expect, it } from 'vitest'

import { app } from './server'

describe('users RPC', () => {
  const client = testClient(app)

  it('creates a user and reads it back with typed bodies', async () => {
    const created = await client.users.$post({ json: { name: 'Ada', email: 'ada@example.com' } })
    expect(created.status).toBe(200)
    const user = await created.json()

    const fetched = await client.users[':id'].$get({ param: { id: user.id } })
    expect(fetched.status).toBe(200)
    expect(await fetched.json()).toEqual(user)
  })

  it('rejects an invalid body at runtime with 422', async () => {
    const res = await client.users.$post({ json: { name: '', email: 'not-an-email' } })
    expect(res.status).toBe(422)
  })
})
```

## Worked example

[`examples/hello-client`](https://github.com/VicenzoMF/kata/tree/main/examples/hello-client)
is a runnable, type-checked demonstration of everything above:

- `src/server.ts` builds the app and exports `AppType`.
- `src/client.ts` consumes it with `hc<AppType>`, plus a tuple of compile-time type
  proofs and `@ts-expect-error` lines that fail `tsc` the moment the runtime and the
  type layer disagree.
- `src/client.test.ts` exercises the same routes at runtime through `testClient(app)`.

The type proofs are the test: `tsc --noEmit` is run in CI, so a regression in the
runtime-to-type bridge turns a proof `false` and fails the build.
