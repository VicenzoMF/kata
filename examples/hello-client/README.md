# hello-client — end-to-end RPC typing (epic #11)

Demonstrates Kata's payoff: a typed `createApp` so Hono's `hc<typeof app>` gives
clients **end-to-end type safety with zero codegen**. Paths, request inputs (from
`input` schemas) and responses (from `output` schemas) are all inferred from the
same Zod schemas the server validates against.

## The three pieces

| File | Role |
| --- | --- |
| `src/modules/users/*` | A normal Kata module — `.schema.ts` DTOs, `.service.ts` logic, `.route.ts` routes. |
| `src/server.ts` | Builds the app and exports its type: `export type AppType = typeof app` (≡ `KataApp<Modules>`). This is the only thing a client needs. |
| `src/client.ts` | `const client = hc<AppType>(baseUrl)` — a fully typed client. The `RpcTypeProofs` tuple and `@ts-expect-error` lines are compile-time assertions. |

In a real deployment `server.ts` lives in one package and `client.ts` in another
(a frontend, a microservice). The **only** shared artifact is the exported
`AppType` — no generated code, no runtime coupling. The server's DI registry
(`defineContext`) never reaches the wire, so the client's Hono `Env` stays
`BlankEnv`.

```ts
import { hc } from 'hono/client'
import type { AppType } from 'server' // the only import the client needs

const client = hc<AppType>('https://api.example.com')

const res = await client.users.$post({ json: { name: 'Ada', email: 'a@b.io' } })
const user = await res.json() // { id: string; name: string; email: string }

await client.users.$post({ json: { name: 'no-email' } }) // ✗ compile error
```

## Run it

```sh
pnpm --filter hello-client start     # serve the typed routes on :3001
pnpm --filter hello-client typecheck # run the compile-time type proofs (client.ts)
pnpm test                            # runtime round-trip via hono/testing testClient
```

## Why this is also a test

`client.ts` is the **typecheck-as-test fixture**: `tsc --noEmit` is its whole
test, so CI fails the moment the runtime and the type layer disagree.
`client.test.ts`
exercises the same routes at runtime through `testClient(app)`, pinning the two
together.
