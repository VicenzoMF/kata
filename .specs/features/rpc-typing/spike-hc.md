# Spike: Hono `hc<typeof app>` integration for Kata

- **Issue:** [#12](https://github.com/VicenzoMF/kata/issues/12) — _Investigate Hono
  `hc<typeof app>` integration_ (epic [#11](https://github.com/VicenzoMF/kata/issues/11),
  _End-to-end RPC typing_)
- **Type:** research spike — **no source changes**. Recommendation feeds #13/#14.
- **Verified against:** `hono@4.12.21`, `zod@3.25.76`, `typescript@5.9.3` (strict).
- **Fixture (the acceptance artifact):** [`poc/hc-spike.poc.ts`](./poc/hc-spike.poc.ts) —
  a type-only file that compiles green and whose `@ts-expect-error` / `Expect<Equal<…>>`
  lines are executable assertions (mutate any one → `tsc` fails; proven below).

---

## TL;DR

`hc<typeof app>` **can** give Kata zero-codegen end-to-end typing, but **not today**:
Kata's `createApp` returns a bare `Hono` whose route schema is the empty
`BlankSchema`, so `hc` sees **zero routes**.

The fix does **not** require rewriting Kata's runtime (the dynamic registration
loop can stay verbatim). It requires one thing: **make `createApp` _return_ a
`Hono<Env, Schema>` whose `Schema` is computed at the type level from the route
definitions**, then cast the built app to it. The PoC implements that mapper
(`ModulesToHonoSchema`) and proves the resulting `hc` client is fully typed —
request bodies, path params, and responses all inferred from the Kata Zod schemas.

---

## The four questions, answered

### 1. Does `hc<typeof app>` work when routes are registered in a loop (not chained)?

**No.** Hono's RPC inference reads exactly one thing: the `Schema` type parameter
of `Hono<Env, Schema, BasePath>` (`hc<T>` → `ExtractSchema<T>` → `Client<T>`). That
`Schema` is accumulated **only through method chaining** — every `.get()/.post()`
returns `Hono<…, S & ToSchema<M, P, I, R>, …>` (see Hono's `hono-base.d.ts`).

Kata registers routes in a runtime `for` loop (`buildHonoApp`, `context.ts:140`)
via a dynamically looked-up, **untyped** registrar
(`register.call(app, route.path, handler)`, `context.ts:260-265`). A runtime loop
accumulates **no** types, and the registrar's return value is discarded. So `app`
keeps its initial `Hono` type = `Hono<BlankEnv, {}, '/'>`.

> Proven in §A of the PoC: `type _ProofCurrentSchemaIsEmpty = Expect<Equal<SchemaOf<typeof currentApp>, {}>>`
> passes, and `client.users.$get` is a **compile error** (the client exposes no routes).
> This is the silent-degradation trap: no error _at the call site that matters_, just
> an empty client and no autocomplete.

### 2. What would `createApp` need to return for `hc` to infer routes?

It must return `Hono<Env, S>` where `S` is a real Hono `Schema` describing every
route. Two gaps block this today, **both in the type layer only**:

1. **`defineRoute` throws away the per-route literals.** Its config types
   `method: HttpMethod` and `path: string` (wide, not generic), and it returns the
   widened `Route<R>` (`context.ts:110-117`, `Route<R>` at `context.ts:79-87`).
   After `defineRoute`, `method`/`path`/`input`/`output` literal types are gone —
   there is nothing left to build a `Schema` from.
2. **`createApp` is not generic over its modules.** `AppConfig<R>.modules` is
   `readonly Module<R>[]` (route values erased), and the return is a bare `Hono`.

So #13/#14 must (a) preserve route literals through `defineRoute`, (b) make
`createApp` generic over the exact modules tuple, and (c) map that tuple to a
Hono `Schema` and cast the return. The **runtime is untouched.** See
[“Do this in #13/#14”](#do-this-in-1314).

### 3. How do Kata's `input`/`output` Zod schemas map to `hc` request/response types?

A Hono `Schema` entry is
`{ [path]: { [`$${method}`]: { input; output; outputFormat; status } } }`. The
client turns `input` into the request argument and `output` into the typed
response. The Kata → Hono bridge (names differ; request vs. response differ):

| Kata route field | Zod | Hono endpoint key | TS type used | Why |
| --- | --- | --- | --- | --- |
| `input.body` | `ZodTypeAny` | `input.json` | `z.input<S>` | request payload, pre-parse |
| `input.query` | `ZodTypeAny` | `input.query` | `z.input<S>` | request, pre-parse |
| `input.params` | `ZodTypeAny` | `input.param` | `z.input<S>` | request; note rename `params → param` |
| `input.headers` | `ZodTypeAny` | `input.header` | `z.input<S>` | request, pre-parse |
| `output` | `ZodTypeAny` | `output` (+ `outputFormat: 'json'`, `status: 200`) | `z.infer<S>` | response, **post-parse** |

Request side uses **`z.input`** (what the caller sends, before Zod transforms);
response side uses **`z.infer`** (= `z.output`, what Kata validates then `c.json()`s).
Kata's DI registry (`defineContext`) maps to **nothing** on the wire — it is
server-only — so the client's Hono `Env` stays `BlankEnv`.

> Proven in §C of the PoC with Hono's own helpers:
> `InferRequestType<client.users.$post>['json']` ≡ `{ name: string; email: string }`,
> `InferResponseType<client.users[':id'].$get>` ≡ `{ id; name; email }`,
> `InferResponseType<client.users.$get>` ≡ `{ id; name; email }[]`.

### 4. Minimal proof-of-concept

[`poc/hc-spike.poc.ts`](./poc/hc-spike.poc.ts). Type-only, never executed;
`tsc --noEmit` (strict) is the whole test. Three sections: **§A** negative control
(today's empty client), **§B** baseline (native chaining, what `hc` actually reads),
**§C** the recommendation (Kata routes → Hono `Schema` → fully typed `hc`).

---

## How the recommendation works (the core of the PoC)

Keep the runtime loop; compute the `Schema` from literal-preserving route specs
and cast the return. The whole mapper is ~30 lines:

```ts
// (1) defineRoute must PRESERVE literals (const M/P; thread I/O into the return).
//     Today it widens to Route<R>, erasing all four — that is the blocker.
type RouteSpec<M extends HttpMethod, P extends string, I extends InputSchemas, O extends z.ZodTypeAny> =
  { method: M; path: P; input: I; output: O }

// (2a) Kata target names → Hono client target names.
type HonoTarget<K> =
  K extends 'body' ? 'json' : K extends 'params' ? 'param' :
  K extends 'query' ? 'query' : K extends 'headers' ? 'header' : never

// (2b) Kata input → Hono endpoint input (request side uses z.input).
type KataToHonoInput<I extends InputSchemas> = {
  [K in keyof I as I[K] extends z.ZodTypeAny ? HonoTarget<K> : never]:
    I[K] extends infer S extends z.ZodTypeAny ? z.input<S> : never
}

// (2c) One route → one Schema entry (response side uses z.infer, always JSON).
type RouteToSchema<S> = S extends RouteSpec<infer M, infer P, infer I, infer O>
  ? { [Path in P]: { [Method in M as `$${Lowercase<Method>}`]:
      { input: KataToHonoInput<I>; output: z.infer<O>; outputFormat: 'json'; status: 200 } } }
  : never

// (3) Flatten modules → union of routes → intersect into one Schema (the same
//     `S & ToSchema<…>` shape Hono builds by chaining; merges $get/$post per path).
type AllRoutes<M extends readonly AnyModule[]> = { [I in keyof M]: M[I][keyof M[I]] }[number]
type ModulesToHonoSchema<M extends readonly AnyModule[]> =
  UnionToIntersection<RouteToSchema<AllRoutes<M>>>

// (4) THE RECOMMENDATION, in one line — runtime untouched, only the type changes:
const app = createApp({ modules: [usersModule] }) as unknown as Hono<Env, ModulesToHonoSchema<[typeof usersModule]>>
const client = hc<typeof app>('/')      // ← fully typed, zero codegen
```

With that, the client is exactly as typed as a hand-chained Hono app:

```ts
await client.users[':id'].$get({ param: { id: 'u_1' } }) // res.json(): { id; name; email }
await client.users.$post({ json: { name: 'Ada', email: 'a@b.io' } })
await client.users.$post({ json: { name: 'no-email' } }) // ✗ compile error: email required
```

---

## Do this in #13/#14

The spike de-risks the implementation to these concrete, **type-only** edits in
`packages/kata/src/context.ts` (+ `types.ts`). The runtime (`buildHonoApp`,
`registerRoute`) does **not** change.

1. **Preserve route literals in `defineRoute`** — add `const M extends HttpMethod`
   and `const P extends string` type params, keep the existing `const I`/`const O`,
   and **return a type that carries all four** (e.g. `Route<R, M, P, I, O>` or a
   structural `{ __kata:'route'; method:M; path:P; input:I; output:O; … }`) instead
   of widening to `Route<R>`. _This is the keystone — nothing else works without it._
2. **Make `Module`/`AppConfig`/`createApp` generic over the modules tuple** —
   `createApp<const Mods extends readonly Module[]>(config: { modules: Mods }):
   Hono<Env, ModulesToHonoSchema<Mods>>`.
3. **Add the `ModulesToHonoSchema` machinery** (the mapper above) to the framework
   types, and **cast** the app built by the loop to `Hono<Env, ModulesToHonoSchema<Mods>>`
   at the single `createApp` return site. The cast is sound because the runtime
   genuinely registers exactly those routes.
4. **Expose the app type for consumers** — e.g. `export type AppType = ReturnType<typeof createApp>`
   so frontends/microservices do `hc<AppType>(baseUrl)` with no codegen.
5. **Add a typecheck-as-test fixture** (like this PoC) to CI so the runtime↔type
   agreement can't silently regress.

---

## Risks, edge cases & open questions for #13/#14

- **Coerced query/param/header.** `z.input` of a `z.coerce.number()` is `unknown`.
  Path/query/header values arrive as strings; #13/#14 should likely type these
  targets from the **string-side** (pre-coercion) input, or constrain them. The PoC
  uses plain `z.string()` fields, so its types are exact; coercion is unverified.
- **Only `status: 200` / single success shape is modeled.** Kata returns `c.json(data)`
  on success and validates `output`; its 422/404/500 envelopes are not in the typed
  client. Hono can model multiple statuses, but Kata's single `output` schema maps
  cleanly to one success endpoint. Treat error-response typing as out of scope / a
  follow-up.
- **Paths must be string literals.** Hono `Schema` keys are literal paths; a computed
  `path` can't be typed. Kata routes already use literal paths — keep it that way (a
  lint rule could enforce it).
- **The boundary cast is deliberate.** `as unknown as Hono<…>` is the one place the
  runtime and the type layer are bridged by hand. Item 5 above (a typecheck fixture)
  is how we keep them honest; this does **not** reintroduce `any`.
- **`defineContext` DI ≠ Hono `Env`.** Kata threads its own context object, so the
  client's `Env` is `BlankEnv` and DI never leaks to the wire. No action needed —
  just don't try to map the registry into `Env`.

---

## How to verify the fixture

The PoC imports Hono RPC subpaths (`hono/client`, `hono/types`) that only resolve
from a package depending on `hono`, and a committed `tsconfig` would trip the kata
config-guard hook. So copy it beside the example app and type-check with flags
(from the repo root):

```sh
cp .specs/features/rpc-typing/poc/hc-spike.poc.ts examples/hello/.hc-verify.ts
node ./node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc \
  --noEmit --strict --noUncheckedIndexedAccess --target ES2022 \
  --module ESNext --moduleResolution Bundler --verbatimModuleSyntax \
  --isolatedModules --skipLibCheck --lib ES2022,DOM examples/hello/.hc-verify.ts
rm examples/hello/.hc-verify.ts
```

Expected: **exit 0**. The assertions have teeth — mutation-tested during the spike:
breaking a positive proof yields `TS2344: Type 'false' does not satisfy the
constraint 'true'`; making a negative proof valid yields `TS2578: Unused
'@ts-expect-error' directive`.
