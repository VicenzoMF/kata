/**
 * RPC client (issue #15, epic #11) — the consumer side of Kata's end-to-end
 * typing. A real frontend imports *only* `AppType` from the server package and
 * gets a fully typed client with zero codegen:
 *
 *   const client = hc<AppType>('https://api.example.com')
 *   const res = await client.users.$post({ json: { name, email } }) // typed body
 *   const user = await res.json()                                    // typed response
 *
 * The `Expect<Equal<…>>` tuple and `@ts-expect-error` lines below are executable
 * assertions: `tsc --noEmit` (run by `pnpm typecheck` in CI) is the test — mutate
 * any one and the typecheck fails. They are the spike's "typecheck-as-test
 * fixture" (item 5), keeping Kata's runtime↔type bridge honest. A runtime
 * round-trip against the same routes is exercised in client.test.ts.
 */
import type { Hono, InferRequestType, InferResponseType } from 'hono'
import { hc } from 'hono/client'
import type { BlankEnv } from 'hono/types'
import type { KataApp } from 'kata'

import type { AppType, Modules } from './server'

/** The typed client — this is the entire consumer-facing API surface. */
export const client = hc<AppType>('http://localhost:3001')

// ── Real call sites, fully typed (compiled as proof; executed in the test) ──

export async function listUsers(search?: string) {
  const res = await client.users.$get({ query: { q: search } })
  return res.json() // { id: string; name: string; email: string }[]
}

export async function getUser(id: string) {
  const res = await client.users[':id'].$get({ param: { id } })
  // Multi-status (ADR-0011): the client narrows on the HTTP status with full
  // types — the 404 branch sees the error envelope, the 200 branch the user.
  if (res.status === 404) {
    const { error } = await res.json() // ErrorBody — { error: string; message: string }
    return { notFound: true as const, error }
  }
  return res.json() // { id: string; name: string; email: string }
}

export async function createUser(name: string, email: string) {
  const res = await client.users.$post({ json: { name, email } })
  return res.json() // { id: string; name: string; email: string }
}

// ── Type-equality harness (no `any`) ──

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type EnvOf<T> = T extends Hono<infer E, infer _S, infer _B> ? E : never

/**
 * Positive proofs — request/response shapes ARE the Kata Zod schemas, extracted
 * with Hono's own client-inference helpers. Aggregated into one exported tuple
 * so every assertion is referenced; any regression turns an entry `false` and
 * fails `tsc`.
 */
export type RpcTypeProofs = [
  // POST /users request body === z.input<CreateUserBodySchema>
  Expect<
    Equal<InferRequestType<typeof client.users.$post>['json'], { name: string; email: string }>
  >,
  // GET /users/:id 200 response === z.infer<UserSchema>. ADR-0011: the route now
  // declares `{ 200: UserSchema, 404: ErrorBodySchema }`, so the response is a
  // per-status union and we narrow it with the status argument to InferResponseType.
  Expect<
    Equal<
      InferResponseType<(typeof client.users)[':id']['$get'], 200>,
      { id: string; name: string; email: string }
    >
  >,
  // GET /users/:id 404 carries the unified error envelope (ADR-0008), typed for the client.
  Expect<Equal<InferResponseType<(typeof client.users)[':id']['$get'], 404>['error'], string>>,
  // GET /users response === z.infer<UserSchema>[]
  Expect<
    Equal<
      InferResponseType<typeof client.users.$get>,
      { id: string; name: string; email: string }[]
    >
  >,
  // #14: the exported `KataApp<Modules>` names the exact type `createApp` returns.
  Expect<Equal<AppType, KataApp<Modules>>>,
  // DI never reaches the wire: the client's Hono `Env` stays `BlankEnv` (ADR-0004).
  Expect<Equal<EnvOf<AppType>, BlankEnv>>,
]

// ── Negative proofs: each statement MUST fail to type-check ──

// @ts-expect-error  body must satisfy CreateUserBodySchema (email is required)
void client.users.$post({ json: { name: 'no-email' } })

// @ts-expect-error  path param `id` is a string, not a number
void client.users[':id'].$get({ param: { id: 123 } })

// @ts-expect-error  query `q` is a string, not a number
void client.users.$get({ query: { q: 123 } })
