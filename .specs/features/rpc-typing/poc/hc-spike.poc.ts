// PoC — Issue #12 (epic #11): can Hono's `hc<typeof app>` give Kata end-to-end
// RPC typing today, and what must `createApp` return for it to work?
//
// This file is TYPE-LEVEL ONLY. It is never executed — `tsc --noEmit` is the
// whole test. Verified strict against hono@4.12.21, zod@3.25.76, typescript@5.9.3.
//
// It imports Hono RPC subpaths (`hono/client`, `hono/types`), which only resolve
// from a package that depends on hono. A committed tsconfig would also trip the
// kata config-guard hook. So verify by copying it beside the example app (which
// depends on hono) and type-checking with flags, from the repo root:
//
//   cp .specs/features/rpc-typing/poc/hc-spike.poc.ts examples/hello/.hc-verify.ts
//   node ./node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc \
//     --noEmit --strict --noUncheckedIndexedAccess --target ES2022 \
//     --module ESNext --moduleResolution Bundler --verbatimModuleSyntax \
//     --isolatedModules --skipLibCheck --lib ES2022,DOM examples/hello/.hc-verify.ts
//   rm examples/hello/.hc-verify.ts
//
// Expected: exit 0. The `@ts-expect-error` / `Expect<Equal<…>>` lines are the
// assertions — mutate any one and tsc fails. Findings: ../spike-hc.md

import type { InferRequestType, InferResponseType } from 'hono'
import { Hono } from 'hono'
import { hc } from 'hono/client'
import type { BlankEnv } from 'hono/types'
import type { HttpMethod, InferInput, InputSchemas } from 'kata'

import { defineContext, singleton } from 'kata'
import { z } from 'zod'

// Tiny type-equality harness (no `any`). `Expect<Equal<X, Y>>` fails to compile
// unless X and Y are identical — every `_Proof*` below is an executable claim.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// Shared DTOs (mirror examples/hello/src/modules/users/users.schema.ts).
const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})
const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

// ───────────────────────────────────────────────────────────────────────────
// §A  NEGATIVE CONTROL — Kata's current createApp returns a bare `Hono`
// ───────────────────────────────────────────────────────────────────────────
// `createApp` (packages/kata/src/context.ts:129) is typed `(): Hono`, i.e. the
// DEFAULT `BlankSchema`. Routes are registered in a runtime loop (buildHonoApp,
// line 140), so no per-route shape is ever accumulated into the `Schema` type
// parameter. `hc` therefore sees nothing.

const k = defineContext({ clock: singleton({ now: () => 0 }) })

const aRoute = k.defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => ({ id: c.input.params.id, name: 'A', email: 'a@b.c' }),
})

const currentApp = k.createApp({ modules: [{ aRoute }] })
const blindClient = hc<typeof currentApp>('http://localhost')

// `currentApp` is `Hono` => ExtractSchema = BlankSchema = {} => zero typed routes.
// @ts-expect-error  a bare `Hono` carries no routes, so `.users` does not exist
void blindClient.users.$get

// Proof, at the type level, that today's createApp yields an EMPTY schema:
type SchemaOf<T> = T extends Hono<infer _E, infer S, infer _B> ? S : never
type _ProofCurrentSchemaIsEmpty = Expect<Equal<SchemaOf<typeof currentApp>, {}>>

// ───────────────────────────────────────────────────────────────────────────
// §B  BASELINE — native Hono chaining is what `hc` actually reads
// ───────────────────────────────────────────────────────────────────────────
// Every chained `.get()/.post()` returns `Hono<…, S & ToSchema<…>, …>`. The
// Schema accumulates THROUGH THE CHAIN — never through a runtime loop. This is
// the mechanism Kata must reproduce.

const chained = new Hono()
  .get('/ping', (c) => c.json({ pong: true }))
  .post('/echo', (c) => c.json({ echoed: 'hi' }))

const baseClient = hc<typeof chained>('http://localhost')

export async function proveBaseline() {
  const res = await baseClient.ping.$get()
  const body = await res.json() // body: { pong: boolean } — inferred from c.json()
  return body.pong
}

// ───────────────────────────────────────────────────────────────────────────
// §C  RECOMMENDATION — derive Hono's `Schema` from Kata route definitions
// ───────────────────────────────────────────────────────────────────────────
// The runtime loop can stay. Only the *return TYPE* of createApp changes:
// compute a Hono `Schema` from the modules and cast the app to `Hono<Env, S>`.
// Two pieces are required:
//   1. defineRoute must PRESERVE the literal method/path/input/output types —
//      today it widens to `Route<R>` (context.ts:117), erasing every one.
//   2. a type-level `ModulesToHonoSchema` mapper (below).

// (1) Literal-preserving route — the signature #13/#14 should adopt. The `const`
// type parameters are what stop `'GET'`/`'/users/:id'` from widening.
type RouteSpec<
  M extends HttpMethod,
  P extends string,
  I extends InputSchemas,
  O extends z.ZodTypeAny,
> = { method: M; path: P; input: I; output: O }

function defineTypedRoute<
  const M extends HttpMethod,
  const P extends string,
  I extends InputSchemas,
  O extends z.ZodTypeAny,
>(
  spec: RouteSpec<M, P, I, O> & {
    handler: (c: { input: InferInput<I> }) => Promise<z.infer<O>> | z.infer<O>
  },
): RouteSpec<M, P, I, O> {
  return { method: spec.method, path: spec.path, input: spec.input, output: spec.output }
}

// (2a) Kata target names → Hono client target names.
type HonoTarget<K> = K extends 'body'
  ? 'json'
  : K extends 'params'
    ? 'param'
    : K extends 'query'
      ? 'query'
      : K extends 'headers'
        ? 'header'
        : never

// (2b) Kata `input` ({ params, query, body, headers }) → Hono endpoint input
// ({ param, query, json, header }). Request side uses `z.input` (pre-parse).
type KataToHonoInput<I extends InputSchemas> = {
  [K in keyof I as I[K] extends z.ZodTypeAny ? HonoTarget<K> : never]: I[K] extends infer S extends
    z.ZodTypeAny
    ? z.input<S>
    : never
}

// (2c) One Kata route → one Hono `Schema` entry. Response side uses `z.infer`
// (post-parse) and is always JSON (Kata validates output then `c.json()`s it).
type RouteToSchema<S> =
  S extends RouteSpec<
    infer M extends HttpMethod,
    infer P extends string,
    infer I extends InputSchemas,
    infer O extends z.ZodTypeAny
  >
    ? {
        [Path in P]: {
          [Method in M as `$${Lowercase<Method>}`]: {
            input: KataToHonoInput<I>
            output: z.infer<O>
            outputFormat: 'json'
            status: 200
          }
        }
      }
    : never

type AnyRouteSpec = RouteSpec<HttpMethod, string, InputSchemas, z.ZodTypeAny>
type AnyModule = Readonly<Record<string, AnyRouteSpec>>

// Flatten `[ModuleA, ModuleB, …]` to a union of every route spec they contain.
type AllRoutes<Mods extends readonly AnyModule[]> = {
  [Idx in keyof Mods]: Mods[Idx][keyof Mods[Idx]]
}[number]

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never

// Distribute over the union, then intersect — same `S & ToSchema<…>` shape Hono
// builds by chaining. Two routes on one path merge their `$get`/`$post` keys.
type ModulesToHonoSchema<Mods extends readonly AnyModule[]> = UnionToIntersection<
  RouteToSchema<AllRoutes<Mods>>
>

// ── Routes defined with the literal-preserving signature ──
const listUsers = defineTypedRoute({
  method: 'GET',
  path: '/users',
  input: {},
  output: z.array(UserSchema),
  handler: async () => [],
})

const getUser = defineTypedRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => ({ id: c.input.params.id, name: 'Ada', email: 'ada@x.io' }),
})

const createUser = defineTypedRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => ({ id: 'u_1', name: c.input.body.name, email: c.input.body.email }),
})

const usersModule = { listUsers, getUser, createUser }

type UsersApiSchema = ModulesToHonoSchema<[typeof usersModule]>

// THE RECOMMENDATION, in one line: keep the runtime, re-type the return.
// `runtime` stands in for `k.createApp({ modules: [usersModule] })` — whose
// dynamic registration loop is left exactly as it is today.
const runtime = new Hono()
const app = runtime as unknown as Hono<BlankEnv, UsersApiSchema>

const client = hc<typeof app>('http://localhost')

export async function proveTypedClient() {
  // GET /users/:id — `param.id` typed `string` from the Zod params schema.
  const r1 = await client.users[':id'].$get({ param: { id: 'u_1' } })
  const user = await r1.json() // { id: string; name: string; email: string }

  // POST /users — `json` body typed from CreateUserBodySchema.
  const r2 = await client.users.$post({ json: { name: 'Ada', email: 'ada@x.io' } })
  const created = await r2.json() // User

  // GET /users — no input; output is User[].
  const r3 = await client.users.$get()
  const all = await r3.json() // User[]

  return { user, created, all }
}

// Compile-time guarantees (positive proofs — request/response shapes are EXACTLY
// the Kata Zod schemas, extracted with Hono's own client inference helpers):

// POST /users request body === z.input<CreateUserBodySchema>
type _ProofPostBody = Expect<
  Equal<InferRequestType<typeof client.users.$post>['json'], { name: string; email: string }>
>
// GET /users/:id response === z.infer<UserSchema>
type _ProofGetResponse = Expect<
  Equal<
    InferResponseType<(typeof client.users)[':id']['$get']>,
    { id: string; name: string; email: string }
  >
>
// GET /users response === z.infer<UserSchema>[]
type _ProofListResponse = Expect<
  Equal<InferResponseType<typeof client.users.$get>, { id: string; name: string; email: string }[]>
>

// Compile-time guarantees (negative proofs — each line MUST fail to type-check):

// @ts-expect-error  body must satisfy CreateUserBodySchema (email is required)
void client.users.$post({ json: { name: 'no-email' } })

// @ts-expect-error  path param `id` is a string, not a number
void client.users[':id'].$get({ param: { id: 123 } })
