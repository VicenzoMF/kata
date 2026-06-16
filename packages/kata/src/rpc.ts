/**
 * RPC type bridge (issues #13/#14, epic #11) — derive Hono's RPC `Schema` from a
 * tuple of Kata modules so `hc<KataApp<typeof modules>>` infers paths, request
 * inputs (from `input` schemas), and responses (from `output` schemas) with zero
 * codegen.
 *
 * This file is **type-level only** — it emits no runtime code. The runtime route
 * registration loop in `context.ts` is untouched; `createApp` merely casts the
 * built `Hono` to `KataApp<Mods>`. That single cast is sound because the loop
 * registers exactly the routes the modules declare; the `examples/hello-client`
 * type fixture (typechecked in CI) keeps the cast honest.
 */
import type { Hono } from 'hono'
import type { BlankEnv, Schema } from 'hono/types'
import type { z } from 'zod'

import type { HttpMethod, InputSchemas, OutputMap, OutputSpec } from './context'

/**
 * The wire-relevant projection of a route. A real `Route<R, M, P, I, O>` is a
 * structural supertype of this, so the mapper reads its literals without coupling
 * to the route's registry, middleware, or handler types.
 */
type RouteLike = {
  readonly method: HttpMethod
  readonly path: string
  readonly input: InputSchemas
  readonly output: OutputSpec
}

/** A module is a record of named routes — e.g. `import * as users from './users.route'`. */
export type RpcModule = Readonly<Record<string, RouteLike>>

/** Kata input target name → Hono client target name (`params` renames to `param`). */
type HonoTarget<K> = K extends 'body'
  ? 'json'
  : K extends 'params'
    ? 'param'
    : K extends 'query'
      ? 'query'
      : K extends 'headers'
        ? 'header'
        : never

/**
 * Kata `input` (`{ params, query, body, headers }`) → Hono endpoint input
 * (`{ param, query, json, header }`). The request side uses `z.input` (the shape
 * the caller sends, before Zod transforms).
 */
type KataToHonoInput<I extends InputSchemas> = {
  [K in keyof I as I[K] extends z.ZodTypeAny ? HonoTarget<K> : never]: I[K] extends infer S extends
    z.ZodTypeAny
    ? z.input<S>
    : never
}

/** One Hono `Schema` endpoint entry — always JSON; response side uses `z.infer` (post-parse). */
type HonoEndpoint<I extends InputSchemas, Out, S extends number> = {
  input: KataToHonoInput<I>
  output: Out
  outputFormat: 'json'
  status: S
}

/**
 * The endpoint(s) a Kata `output` contributes. A single schema → one `status: 200`
 * endpoint (ADR-0003, unchanged). A status→schema map → a union of endpoints, one
 * per declared status (ADR-0011) — the exact shape Hono accumulates from chained
 * `c.json(body, status)` calls, so the client narrows with
 * `InferResponseType<call, Status>`.
 */
type OutputEndpoints<I extends InputSchemas, O extends OutputSpec> = O extends z.ZodTypeAny
  ? HonoEndpoint<I, z.infer<O>, 200>
  : O extends OutputMap
    ? { [S in keyof O & number]: HonoEndpoint<I, z.infer<O[S]>, S> }[keyof O & number]
    : never

/**
 * One Kata route → its Hono `Schema` entry. Distributes over a union of routes;
 * two routes on one path merge their `$get`/`$post` keys via the intersection in
 * {@link ModulesToHonoSchema}.
 */
type RouteToSchema<T> = T extends {
  method: infer M extends HttpMethod
  path: infer P extends string
  input: infer I extends InputSchemas
  output: infer O extends OutputSpec
}
  ? {
      [Path in P]: {
        [Method in M as `$${Lowercase<Method>}`]: OutputEndpoints<I, O>
      }
    }
  : never

/** Flatten `[ModuleA, ModuleB, …]` to a union of every route they contain. */
type AllRoutes<Mods extends readonly RpcModule[]> = {
  [Idx in keyof Mods]: Mods[Idx][keyof Mods[Idx]]
}[number]

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never

/**
 * Map a modules tuple to the Hono RPC `Schema`. Distributing `RouteToSchema` over
 * the route union, then intersecting, reproduces the exact `S & ToSchema<…>` shape
 * Hono accumulates by method chaining — two routes on one path merge their
 * `$get`/`$post` keys.
 */
export type ModulesToHonoSchema<Mods extends readonly RpcModule[]> =
  UnionToIntersection<RouteToSchema<AllRoutes<Mods>>> extends infer S extends Schema ? S : never

/**
 * The typed `Hono` app `createApp` returns (issue #14). A server exposes its app
 * type — `export type AppType = KataApp<typeof modules>` — and a client consumes
 * it with no codegen: `const client = hc<AppType>(baseUrl)`. The DI registry never
 * reaches the wire, so the client's `Env` stays `BlankEnv`.
 */
export type KataApp<Mods extends readonly RpcModule[]> = Hono<BlankEnv, ModulesToHonoSchema<Mods>>
