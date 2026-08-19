import type { Hono } from 'hono'
import { Hono as HonoApp } from 'hono'
import type { z } from 'zod'

import type { ErrorExtra, FieldIssue } from './errors'
import { buildErrorBody, formatZodIssues, serializeError } from './errors'
import { type Logger, logFrameworkError, logRequest, resolveLogger } from './logger'
import { type OutputValidationMode, resolveOutputValidationMode } from './output-validation'
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id'
import type { KataApp } from './rpc'
import type { Registry, ResolvedValue, Scoped, ScopedKeys, Singleton, SingletonKeys } from './types'

// ────────────────────────────────────────────────────────────────────────────
// Slot constructors (top-level — used to build the registry)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Declare a **singleton** DI slot (ADR-0004): one value that lives for the whole
 * process lifetime — a db pool, logger, cache, mailer. The `value` is built once,
 * here, and every request reads that same instance via `c.get(key)`.
 *
 * Pass the result to {@link defineContext} under a key; that key then resolves
 * (typed as `T`) from any middleware or route handler:
 *
 * ```ts
 * const context = defineContext({
 *   db: singleton(makeDb(env)), // c.get('db') → Db, always the same instance
 * })
 * ```
 *
 * Contrast with {@link scoped}, whose value is created per request and must be
 * populated by a providing middleware before it can be read.
 */
export function singleton<T>(value: T): Singleton<T> {
  // kata-allow: hono-boundary
  return { __value: value, __kind: 'singleton' } as unknown as Singleton<T>
}

/**
 * Declare a **scoped** DI slot (ADR-0004): a value that is distinct per HTTP
 * request — the current user, tenant id, an active transaction. Unlike
 * {@link singleton}, no value is supplied here; the slot is declared empty, and a
 * middleware listed in the route's `use:` chain must fill it via `c.set(key, …)`
 * before any handler reads it with `c.get(key)`.
 *
 * ```ts
 * const context = defineContext({
 *   user: scoped<User>(), // set per request by an auth middleware that provides 'user'
 * })
 * ```
 *
 * Reading a scoped slot whose providing middleware did not run throws at runtime;
 * the `kata/scoped-slot-not-provided` lint rule catches it statically (ADR-0004).
 */
export function scoped<T>(): Scoped<T> {
  // kata-allow: hono-boundary
  return { __kind: 'scoped' } as unknown as Scoped<T>
}

// ────────────────────────────────────────────────────────────────────────────
// Middleware + Route shapes
// ────────────────────────────────────────────────────────────────────────────

export type MiddlewareContext<R extends Registry> = {
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  set<K extends ScopedKeys<R>>(key: K, value: ResolvedValue<R[K]>): void
  /** Underlying Hono context — escape hatch */
  raw: import('hono').Context
  /** Shortcut: read a request header */
  header(name: string): string | undefined
  /** Return a JSON response (short-circuit) */
  json<T>(value: T, status?: number): Response
  /** Return a unified error response (ADR-0008). Defaults to status 400. */
  error(code: string, message: string, extra?: ErrorExtra): Response
  /**
   * Correlation id for this request (issue #63): the inbound `x-request-id`
   * when well-formed, otherwise a freshly generated UUID. It is framework-owned
   * request context — like `raw`, not a user DI value — so it is a first-class
   * field here rather than a scoped slot; ADR-0004 governs the slot mechanism,
   * and this single sealed value does not reintroduce ad-hoc request state.
   */
  requestId: string
}

export type Middleware<R extends Registry> = {
  readonly __kata: 'middleware'
  readonly provides: readonly ScopedKeys<R>[]
  readonly handler: (
    c: MiddlewareContext<R>,
    next: () => Promise<void>,
  ) => Promise<void | Response> | void | Response
}

export type InputSchemas = {
  params?: z.ZodTypeAny
  query?: z.ZodTypeAny
  body?: z.ZodTypeAny
  headers?: z.ZodTypeAny
}

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined

export type InferInput<I extends InputSchemas> = {
  params: Infer<I['params']>
  query: Infer<I['query']>
  body: Infer<I['body']>
  headers: Infer<I['headers']>
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RouteContext<R extends Registry, I extends InputSchemas> = {
  /**
   * Read a registered dependency. The key must be in `defineContext`, which the
   * type parameter enforces; *whether a scoped slot was actually filled* is a
   * question about the middleware chain, not about types, so `get` types every
   * registered key — scoped ones included (ADR-0004).
   *
   * The chain question is answered statically by `kata verify`'s
   * `kata/scoped-slot-not-provided` rule, which walks
   * `[...createApp({ middlewares }), ...use]` in order and errors when a
   * `c.get('<slot>')` has no middleware ahead of it declaring `provides:
   * ['<slot>']` — a build-time error instead of the runtime throw ("scoped slot
   * '<slot>' read before being set"). Ordering counts: a provider listed *after*
   * the read is an error too.
   *
   * Where an expression in a chain cannot be resolved statically — a middleware
   * built at runtime, or imported from a package that ships no `provides.json`
   * manifest — the rule cannot prove the read either way. It then reports a
   * *suppression* naming the expression rather than passing silently, and
   * `kata verify --strict-coverage` turns those into a non-zero exit.
   */
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  input: InferInput<I>
  raw: import('hono').Context
  json<T>(value: T, status?: number): Response
  /** Return a unified error response (ADR-0008). Defaults to status 400. */
  error(code: string, message: string, extra?: ErrorExtra): Response
  /** Correlation id for this request (issue #63). See {@link MiddlewareContext.requestId}. */
  requestId: string
}

/** A response-body schema keyed by HTTP status code (ADR-0011). */
export type OutputMap = { readonly [status: number]: z.ZodTypeAny }

/**
 * A route's `output` contract (ADR-0011): either a single Zod schema for the
 * success (200) body — the ADR-0003 form — or a map from HTTP status code to
 * the schema for that status's body (e.g. `{ 200: UserSchema, 404: ErrorBodySchema }`).
 */
export type OutputSpec = z.ZodTypeAny | OutputMap

/**
 * The body a handler may return as a *plain value* (not via `c.json` / `c.error`).
 * It is always the 200 body: `z.infer` of the single schema, or of `output[200]`
 * for a map. A map without a `200` entry yields `never` — such a route must
 * return a `Response` (e.g. `c.json(body, 201)`), since a plain return cannot
 * express a non-200 status (ADR-0011).
 */
export type SuccessOutput<O extends OutputSpec> = O extends z.ZodTypeAny
  ? z.infer<O>
  : O extends OutputMap
    ? 200 extends keyof O
      ? z.infer<O[200]>
      : never
    : never

export type RouteHandlerReturn<O extends OutputSpec> = SuccessOutput<O> | Response

export type Route<
  R extends Registry,
  M extends HttpMethod = HttpMethod,
  P extends string = string,
  I extends InputSchemas = InputSchemas,
  O extends OutputSpec = OutputSpec,
> = {
  readonly __kata: 'route'
  readonly method: M
  readonly path: P
  readonly use: readonly Middleware<R>[]
  readonly input: I
  readonly output: O
  // The stored handler stays loose in its input (`InputSchemas`, not the route's
  // own `I`). Keeping `I`/`O` out of every contravariant position makes `Route`
  // covariant in M/P/I/O, so a concrete route remains assignable to `Route<R>`
  // (and to `RpcModule`) — which is what lets `createApp` collect the modules
  // tuple. The precise per-route handler type is still enforced at the
  // `defineRoute` call site below, the only place it actually matters.
  readonly handler: (c: RouteContext<R, InputSchemas>) => Promise<unknown> | unknown
}

export type Module<R extends Registry> = Readonly<Record<string, Route<R>>>

export type AppConfig<
  R extends Registry,
  Mods extends readonly Module<R>[] = readonly Module<R>[],
> = {
  modules: Mods
  /**
   * App-level middleware chain (issue #86, ADR-0012). Runs **before** every
   * route's own `use:` chain — the effective per-route chain is
   * `[...middlewares, ...route.use]`, each in declared (array) order, the global
   * chain outermost. It shares the exact `Middleware<R>` contract, runtime
   * pipeline, and per-request scoped store route middleware uses: a global may
   * short-circuit by returning a `Response`, and a scoped slot it `provides:` is
   * readable via `c.get` in every handler. Declare cross-cutting concerns
   * (`cors()`, `secureHeaders()`, `bodyLimit()`) here once instead of per route.
   */
  middlewares?: readonly Middleware<R>[]
  /**
   * Per-request logging (issue #63). When `true` (the default) and a `logger`
   * singleton is registered, every request is logged — method, path, status,
   * duration, request id — through it. A no-op when no usable logger is
   * registered; set `false` to silence it explicitly.
   */
  requestLogging?: boolean
  /**
   * How an output-schema mismatch is handled (issue #17, ADR-0009): `strict`
   * (log + 500), `log` (log + send the handler's data through), or `off` (skip
   * validation). Defaults to `strict` outside production and `log` in
   * production; overridable here or via the `KATA_OUTPUT_VALIDATION` env var.
   */
  outputValidation?: OutputValidationMode
}

// ────────────────────────────────────────────────────────────────────────────
// defineContext — returns the typed factory
// ────────────────────────────────────────────────────────────────────────────

/**
 * Define the application's DI registry and return the typed factory bound to it
 * (ADR-0004). This is the single entry point for wiring a Kata app: every member
 * of the returned object is typed against this exact registry `R`, so the harness
 * can verify `c.get` / `c.set` keys against it.
 *
 * `registry` maps keys to slots built with {@link singleton} (process-lifetime
 * values) and {@link scoped} (per-request values). The returned factory exposes:
 *
 * - `registry` — the passed registry, re-exposed for reference.
 * - `defineMiddleware` — declare a middleware; its `provides` keys and the slots
 *   its handler reads/writes via `c.get` / `c.set` are checked against `R`.
 * - `defineRoute` — declare a route with `input` / `output` schemas; its handler's
 *   `c.get(key)` only compiles for keys present in `R`.
 * - `createApp` — assemble the declared modules into a runnable app.
 *
 * ```ts
 * const { defineRoute, defineMiddleware, createApp } = defineContext({
 *   db: singleton(makeDb(env)),
 *   user: scoped<User>(),
 * })
 * ```
 */
export function defineContext<const R extends Registry>(registry: R) {
  function defineMiddleware<const P extends readonly ScopedKeys<R>[]>(config: {
    provides: P
    handler: (
      c: MiddlewareContext<R>,
      next: () => Promise<void>,
    ) => Promise<void | Response> | void | Response
  }): Middleware<R> {
    return { __kata: 'middleware', provides: config.provides, handler: config.handler }
  }

  function defineRoute<
    const M extends HttpMethod,
    const P extends string,
    const I extends InputSchemas,
    const O extends OutputSpec,
  >(config: {
    method: M
    path: P
    use?: readonly Middleware<R>[]
    input: I
    output: O
    handler: (c: RouteContext<R, I>) => Promise<RouteHandlerReturn<O>> | RouteHandlerReturn<O>
  }): Route<R, M, P, I, O> {
    return {
      __kata: 'route',
      method: config.method,
      path: config.path,
      use: config.use ?? [],
      input: config.input,
      output: config.output,
      handler: config.handler as Route<R>['handler'],
    }
  }

  function createApp<const Mods extends readonly Module<R>[]>(
    config: AppConfig<R, Mods>,
  ): KataApp<Mods> {
    // The runtime loop registers exactly the routes `Mods` declares, so casting
    // the built `Hono` to the schema derived from `Mods` is sound (issue #13) —
    // it is the single hand-maintained bridge between the runtime and the type
    // layer. `examples/hello-client` type-checks this bridge in CI (spike item 5).
    // kata-allow: hono-boundary
    return buildHonoApp(registry, config) as unknown as KataApp<Mods>
  }

  /**
   * Read a {@link singleton}'s value **outside** a request (issue #172).
   *
   * Inside a middleware or route handler, prefer `c.get(key)` — the request
   * context resolves both singleton and scoped slots. But bootstrap and teardown
   * code runs with no request in flight: the `serve(...)` callback that logs the
   * listening port, a graceful-shutdown `onClose` that closes the db pool. There
   * `resolve` is the sanctioned way to reach a process-lifetime value, instead of
   * reaching into the slot's internal `__value` field.
   *
   * Only **singleton** keys are accepted: a scoped slot holds no value until a
   * middleware `c.set`s it during a request, so it has nothing to resolve here.
   * The `SingletonKeys<R>` bound rejects scoped keys at compile time, and the
   * runtime guard throws if one slips through an untyped call.
   *
   * ```ts
   * const k = defineContext({ logger: singleton(makeLogger()) })
   * // …
   * serve({ fetch: app.fetch, port }, (info) => {
   *   k.resolve('logger').info(`listening on :${info.port}`)
   * })
   * ```
   *
   * @throws if `key` is not registered, or is registered as a scoped slot.
   */
  function resolve<K extends SingletonKeys<R>>(key: K): ResolvedValue<R[K]> {
    const slot = registry[key as string]
    if (!slot) throw new Error(`kata: key '${String(key)}' not registered in defineContext`)
    if (slot.__kind !== 'singleton') {
      throw new Error(
        `kata: cannot resolve '${String(key)}' outside a request — only singleton slots hold a process-lifetime value`,
      )
    }
    return (slot as Singleton<unknown>).__value as ResolvedValue<R[K]>
  }

  return { registry, defineMiddleware, defineRoute, createApp, resolve } as const
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime — build Hono app from modules
// ────────────────────────────────────────────────────────────────────────────

/** Per-app runtime options resolved once at `createApp` and shared by routes. */
type RuntimeOptions<R extends Registry> = {
  logger: Logger | undefined
  requestLogging: boolean
  outputValidation: OutputValidationMode
  /**
   * App-level middleware chain (ADR-0012), prepended to every route's `use:` at
   * registration. Resolved once here so `registerRoute` does a single array
   * concat per route rather than any per-request work.
   */
  middlewares: readonly Middleware<R>[]
}

function resolveRuntimeOptions<R extends Registry>(
  registry: R,
  config: AppConfig<R>,
): RuntimeOptions<R> {
  return {
    logger: resolveLogger(registry),
    requestLogging: config.requestLogging ?? true,
    outputValidation: resolveOutputValidationMode(config.outputValidation),
    middlewares: config.middlewares ?? [],
  }
}

function buildHonoApp<R extends Registry>(registry: R, config: AppConfig<R>): Hono {
  const app = new HonoApp()
  const options = resolveRuntimeOptions(registry, config)
  // path → declared methods (issue #209): built once here as every route
  // registers, so `notFound` can answer 404 vs 405 with a single Map lookup
  // instead of walking `config.modules` per unmatched request.
  const pathMethods = new Map<string, Set<HttpMethod>>()
  for (const mod of config.modules) {
    for (const route of Object.values(mod)) {
      registerRoute(app, registry, route, options, pathMethods)
    }
  }
  // Global fallback (#62): anything that escapes the route pipeline — a raw
  // Hono handler, or an error thrown while building the kata response itself —
  // still serialises through the unified envelope instead of Hono's default
  // text/HTML 500.
  app.onError((err, c) => {
    logFrameworkError(options.logger, 'kata: unhandled error escaped the route pipeline', {
      err: serializeError(err),
    })
    return errorResponse(c, 'internal_error', 'Internal server error', { status: 500 })
  })
  // No route matched at all (issue #209): otherwise Hono's default handler
  // leaks a text/plain 404 that escapes the ADR-0008 envelope entirely.
  app.notFound(buildNotFoundHandler(app, registry, pathMethods, options))
  return app
}

/** The closed set of methods a route can declare — see {@link HttpMethod}. */
const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const SCOPED_STORE = Symbol('kata.scoped-store')

function getScopedStore(c: import('hono').Context): Map<string, unknown> {
  // kata-allow: hono-boundary
  let store = c.get(SCOPED_STORE as never) as Map<string, unknown> | undefined
  if (!store) {
    store = new Map<string, unknown>()
    // kata-allow: hono-boundary
    c.set(SCOPED_STORE as never, store as never)
  }
  return store
}

const CONTEXT_HEADERS_TOUCHED = Symbol('kata.context-headers-touched')

/**
 * Marks that a Hono middleware wrapped by `fromHono` ran and may have set
 * headers on `c.res` (`secureHeaders()`, `cors()`, …) — the header half of the
 * ADR-0020 response seam (issue #207). Called from `from-hono.ts`, checked by
 * `applyResponseHeaders` before it reads `c.res`: that getter *materialises* a
 * Response, so a request with no app-level middleware must not pay for it.
 */
export function markContextHeadersTouched(c: import('hono').Context): void {
  // kata-allow: hono-boundary
  c.set(CONTEXT_HEADERS_TOUCHED as never, true as never)
}

function contextHeadersTouched(c: import('hono').Context): boolean {
  // kata-allow: hono-boundary
  return c.get(CONTEXT_HEADERS_TOUCHED as never) === true
}

/**
 * Merge `source` (headers a Hono middleware set on `c.res`) onto `target` (the
 * response kata is about to send) — additive only, per ADR-0020 / issue #207:
 * a header the handler already set on its own `Response` wins, and
 * `set-cookie` is appended rather than replaced since it is legitimately
 * multi-valued — a middleware cookie and a handler cookie must both survive.
 */
function mergeContextHeaders(target: Headers, source: Headers): void {
  for (const [key, value] of source) {
    if (key === 'set-cookie') continue
    if (!target.has(key)) target.set(key, value)
  }
  const existingCookies = new Set(target.getSetCookie())
  for (const cookie of source.getSetCookie()) {
    if (!existingCookies.has(cookie)) target.append('set-cookie', cookie)
  }
}

/**
 * Single funnel for every Kata 4xx/5xx response (ADR-0008). Builds the unified
 * envelope via `buildErrorBody` and wraps it in a Hono JSON response. The
 * `as never` casts are the same Hono-boundary casts used by the `json` helpers
 * above — they localise Hono's strict status/body typing, not an `any` escape.
 */
function errorResponse(
  c: import('hono').Context,
  code: string,
  message: string,
  extra?: ErrorExtra,
): Response {
  // kata-allow: hono-boundary
  return c.json(buildErrorBody(code, message, extra) as never, (extra?.status ?? 400) as never)
}

function makeMiddlewareContext<R extends Registry>(
  registry: R,
  c: import('hono').Context,
  requestId: string,
): MiddlewareContext<R> {
  const store = getScopedStore(c)
  return {
    get(key) {
      const slot = registry[key as string]
      if (!slot) throw new Error(`kata: key '${String(key)}' not registered in defineContext`)
      // kata-allow: hono-boundary
      if (slot.__kind === 'singleton') return (slot as Singleton<unknown>).__value as never
      if (!store.has(key as string)) {
        throw new Error(
          `kata: scoped slot '${String(key)}' read before being set. Did the providing middleware run?`,
        )
      }
      // kata-allow: hono-boundary
      return store.get(key as string) as never
    },
    set(key, value) {
      const slot = registry[key as string]
      if (!slot || slot.__kind !== 'scoped') {
        throw new Error(`kata: cannot set '${String(key)}' — not a scoped slot`)
      }
      store.set(key as string, value)
    },
    raw: c,
    header: (name) => c.req.header(name),
    // kata-allow: hono-boundary
    json: (value, status) => c.json(value as never, (status ?? 200) as never),
    error: (code, message, extra) => errorResponse(c, code, message, extra),
    requestId,
  }
}

function makeRouteContext<R extends Registry, I extends InputSchemas>(
  registry: R,
  c: import('hono').Context,
  input: InferInput<I>,
  requestId: string,
): RouteContext<R, I> {
  const store = getScopedStore(c)
  return {
    get(key) {
      const slot = registry[key as string]
      if (!slot) throw new Error(`kata: key '${String(key)}' not registered in defineContext`)
      // kata-allow: hono-boundary
      if (slot.__kind === 'singleton') return (slot as Singleton<unknown>).__value as never
      if (!store.has(key as string)) {
        throw new Error(
          `kata: scoped slot '${String(key)}' read before being set. Did the providing middleware run?`,
        )
      }
      // kata-allow: hono-boundary
      return store.get(key as string) as never
    },
    input,
    raw: c,
    // kata-allow: hono-boundary
    json: (value, status) => c.json(value as never, (status ?? 200) as never),
    error: (code, message, extra) => errorResponse(c, code, message, extra),
    requestId,
  }
}

async function readInputs<I extends InputSchemas>(
  input: I,
  c: import('hono').Context,
): Promise<
  | { ok: true; value: InferInput<I> }
  | { ok: false; issues: Record<string, FieldIssue[]> }
  | { ok: false; response: Response }
> {
  const raw: Record<string, unknown> = {}
  if (input.params) raw['params'] = c.req.param()
  if (input.query) raw['query'] = c.req.query()
  if (input.body) {
    const text = await c.req.text()
    if (!text) {
      raw['body'] = undefined
    } else {
      try {
        raw['body'] = JSON.parse(text)
      } catch {
        return {
          ok: false,
          response: errorResponse(c, 'validation_failed', 'Malformed JSON body', {
            status: 400,
            issues: {
              body: [{ path: '', message: 'Request body is not valid JSON', code: 'custom' }],
            },
          }),
        }
      }
    }
  }
  if (input.headers) {
    // Header keys are normalised to lowercase before validation: HTTP header
    // names are case-insensitive, so an `input.headers` Zod schema must key its
    // fields in lowercase (e.g. `authorization`, not `Authorization`).
    const all: Record<string, string> = {}
    for (const [k, v] of Object.entries(c.req.header())) all[k.toLowerCase()] = v
    raw['headers'] = all
  }

  const parsed: Record<string, unknown> = {}
  const issues: Record<string, FieldIssue[]> = {}
  let failed = false

  for (const key of ['params', 'query', 'body', 'headers'] as const) {
    const schema = input[key]
    if (!schema) {
      parsed[key] = undefined
      continue
    }
    const result = schema.safeParse(raw[key])
    if (!result.success) {
      issues[key] = formatZodIssues(result.error)
      failed = true
    } else {
      parsed[key] = result.data
    }
  }

  if (failed) return { ok: false, issues }
  return { ok: true, value: parsed as InferInput<I> }
}

/** The status a plain (non-`Response`) handler return maps to (ADR-0011). */
const SUCCESS_STATUS = 200

/** A route `output` is a single schema (ADR-0003) or a status→schema map (ADR-0011). */
function isZodSchema(output: OutputSpec): output is z.ZodTypeAny {
  return typeof (output as { safeParse?: unknown }).safeParse === 'function'
}

/**
 * Build + validate the response for whatever the handler returned, honouring the
 * configured mode (ADR-0009) against the route's `output` contract (ADR-0003 single
 * schema or ADR-0011 status→schema map):
 * - a **plain value** is the 200 body — validated against the single schema or
 *   `output[200]`.
 * - a **`Response`** carries its own status; in the map form its body is validated
 *   against `output[status]` when that status is declared. The single-schema form
 *   and undeclared statuses pass the `Response` through unvalidated (back-compat:
 *   a `Response` has always short-circuited output validation).
 */
async function buildResponse<R extends Registry>(
  c: import('hono').Context,
  route: Route<R>,
  result: unknown,
  options: RuntimeOptions<R>,
): Promise<Response> {
  const output = route.output
  if (result instanceof Response) {
    if (options.outputValidation !== 'off' && !isZodSchema(output)) {
      const schema = output[result.status]
      if (schema) return validateResponseBody(c, route, result, schema, options)
    }
    return result
  }
  const successSchema = isZodSchema(output) ? output : output[SUCCESS_STATUS]
  return buildOutputResponse(c, route, result, successSchema, options)
}

/**
 * Validate a plain handler return against the success schema and build the 200
 * response (ADR-0003, ADR-0009):
 * - `off` or no success schema declared — send the data as-is.
 * - match — send the parsed (Zod-transformed) data.
 * - mismatch + `strict` — log and 500 (the body never violates its contract).
 * - mismatch + `log` — log and send the handler's data through unchanged.
 */
function buildOutputResponse<R extends Registry>(
  c: import('hono').Context,
  route: Route<R>,
  result: unknown,
  schema: z.ZodTypeAny | undefined,
  options: RuntimeOptions<R>,
): Response {
  if (options.outputValidation === 'off' || !schema) {
    // kata-allow: hono-boundary
    return c.json(result as never)
  }
  const parsed = schema.safeParse(result)
  if (parsed.success) {
    // kata-allow: hono-boundary
    return c.json(parsed.data as never)
  }
  logOutputMismatch(route, SUCCESS_STATUS, parsed.error.issues, options)
  if (options.outputValidation === 'strict') {
    return outputMismatchResponse(c)
  }
  // mode === 'log': keep serving — send the handler's data through unchanged.
  // kata-allow: hono-boundary
  return c.json(result as never)
}

/**
 * Validate a handler-returned `Response`'s body against the schema declared for
 * its status (ADR-0011), as a shape check. The original `Response` is forwarded
 * verbatim on success — Kata never re-serialises a response the handler built, so
 * a custom header or content type the handler set is preserved. `finalizeResponse`
 * merges in app-level headers afterwards (ADR-0020, issue #207); it is not this
 * function's concern. Reached only in the map form, for a declared status, when
 * the mode is not `off`.
 */
async function validateResponseBody<R extends Registry>(
  c: import('hono').Context,
  route: Route<R>,
  response: Response,
  schema: z.ZodTypeAny,
  options: RuntimeOptions<R>,
): Promise<Response> {
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    // Non-JSON or unreadable body — nothing to validate against the schema.
    return response
  }
  const parsed = schema.safeParse(body)
  if (parsed.success) {
    return response
  }
  logOutputMismatch(route, response.status, parsed.error.issues, options)
  if (options.outputValidation === 'strict') {
    return outputMismatchResponse(c)
  }
  // mode === 'log': keep serving the handler's original response.
  return response
}

/** Server-side diagnostic for an output-schema mismatch — the same line `strict` has always emitted. */
function logOutputMismatch<R extends Registry>(
  route: Route<R>,
  status: number,
  issues: unknown,
  options: RuntimeOptions<R>,
): void {
  const msg = `kata: output schema mismatch in ${route.method} ${route.path} (status ${status})`
  logFrameworkError(options.logger, msg, { issues })
}

/** The 500 envelope (ADR-0008) `strict` returns when a response violates its declared output schema. */
function outputMismatchResponse(c: import('hono').Context): Response {
  return errorResponse(
    c,
    'internal_output_shape_mismatch',
    'Response did not match the declared output schema',
    { status: 500 },
  )
}

/**
 * Merge app-level response headers (ADR-0020, issue #207) and echo the
 * correlation id (issue #63) onto the outgoing response. Both writes share one
 * `Headers` object, so an immutable one — `Response.redirect()`, or a
 * `Response` handed back straight from `fetch()` — is handled once: rebuild a
 * fresh `Response` carrying the merged headers rather than silently drop them.
 * `response.body` is passed through to the rebuild, never buffered, so a
 * streamed download is unaffected.
 */
function applyResponseHeaders(
  c: import('hono').Context,
  response: Response,
  requestId: string,
): Response {
  const touched = contextHeadersTouched(c)
  const apply = (headers: Headers): void => {
    if (touched) mergeContextHeaders(headers, c.res.headers)
    headers.set(REQUEST_ID_HEADER, requestId)
  }
  try {
    apply(response.headers)
    return response
  } catch {
    const headers = new Headers(response.headers)
    apply(headers)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * Final step of every request (issue #63): merge app-level response headers
 * (ADR-0020, issue #207), echo the correlation id, and emit the per-request
 * log line. Runs for every outcome — success, validation failure, middleware
 * short-circuit, the 5xx boundary, or an unmatched route (issue #209) — so no
 * response path is left behind. `route` is widened to a bare descriptor (not
 * `Route<R>`) so `notFound`, which has no route to point at, can share this
 * same funnel with `registerRoute`.
 */
function finalizeResponse<R extends Registry>(
  c: import('hono').Context,
  route: { method: string; path: string },
  requestId: string,
  startedAt: number,
  response: Response | undefined,
  options: RuntimeOptions<R>,
): Response | undefined {
  if (response) {
    response = applyResponseHeaders(c, response, requestId)
  }
  if (options.requestLogging && options.logger) {
    logRequest(options.logger, {
      requestId,
      method: route.method,
      path: route.path,
      status: response?.status ?? 404,
      durationMs: Math.round(performance.now() - startedAt),
    })
  }
  return response
}

/**
 * Run a middleware chain to completion, short-circuiting on the first
 * `Response` a handler returns without calling `next()` (issue #209 factors
 * this out of `registerRoute` so `notFound` can run the same ADR-0012 global
 * chain — no route `use:`, since there is no route — before it ever builds a
 * 404/405; this is also why the CORS preflight responder ADR-0020 documents,
 * once declared as a global, answers `OPTIONS` itself instead of falling into
 * the 405 path below). `onComplete` runs once every entry has called `next()`
 * through to the end, and supplies whatever response follows — a route's
 * input+handler+output pipeline for `registerRoute`, or nothing for a bare
 * global-only chain.
 */
async function runMiddlewareChain<R extends Registry>(
  chain: readonly Middleware<R>[],
  registry: R,
  c: import('hono').Context,
  requestId: string,
  onComplete: () => Promise<Response | undefined>,
): Promise<Response | undefined> {
  let i = 0
  let shortCircuit: Response | undefined
  const step = async (): Promise<void> => {
    if (i >= chain.length) {
      shortCircuit = await onComplete()
      return
    }
    const mw = chain[i++]!
    const mwCtx = makeMiddlewareContext(registry, c, requestId)
    const result = await mw.handler(mwCtx, step)
    if (result instanceof Response) {
      shortCircuit = result
    }
  }
  await step()
  return shortCircuit
}

function registerRoute<R extends Registry>(
  app: Hono,
  registry: R,
  route: Route<R>,
  options: RuntimeOptions<R>,
  pathMethods: Map<string, Set<HttpMethod>>,
): void {
  const method = route.method.toLowerCase() as Lowercase<HttpMethod>
  // Hono router: app.get(path, ...handlers)
  // kata-allow: hono-boundary
  const register = (app as unknown as Record<string, (path: string, ...h: unknown[]) => unknown>)[
    method
  ]
  // Defensive / dead code (issue #176): `route.method` is typed `HttpMethod` — a
  // closed union whose lowercased members (get/post/put/patch/delete) are all real
  // Hono router methods — so `register` is always defined when reached through the
  // typed `defineRoute` API. The guard only fires for an untyped/raw construction;
  // it is unreachable through the public surface, hence left untested by design.
  if (!register) throw new Error(`kata: Hono does not support method '${route.method}'`)
  // path → declared methods (issue #209), fed once per registration so
  // `notFound` can tell a wrong-method request from a truly unknown path.
  const methods = pathMethods.get(route.path)
  if (methods) {
    methods.add(route.method)
  } else {
    pathMethods.set(route.path, new Set([route.method]))
  }
  // Effective chain (ADR-0012): app-level middleware runs before the route's own
  // `use:`, each in declared order, the global chain outermost. Built once here at
  // registration — a global is just an earlier entry in the same array, so the
  // short-circuit capture, shared scoped store, request-id, logging, and 5xx
  // boundary below all cover it for free. Skip the concat when there are no globals.
  const chain = options.middlewares.length > 0 ? [...options.middlewares, ...route.use] : route.use
  register.call(app, route.path, async (c: import('hono').Context) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER))
    const startedAt = performance.now()
    let shortCircuit: Response | undefined
    // Route-pipeline boundary (#62): a throw from any middleware, the handler,
    // or output validation is funnelled into the unified 5xx envelope. The raw
    // error is logged server-side with route context; the client never sees
    // internal detail (ADR-0008, Alt. D).
    try {
      // 1. Run the effective middleware chain (Hono's native middleware would
      //    also work, but threading the kata context is cleaner this way),
      //    then 2. validate input, 3. run the handler, and 4. build +
      //    validate the response against the route's output contract — single
      //    schema (ADR-0003) or status→schema map (ADR-0011) — per the
      //    configured mode (ADR-0009).
      shortCircuit = await runMiddlewareChain(chain, registry, c, requestId, async () => {
        const inputResult = await readInputs(route.input, c)
        if (!inputResult.ok) {
          if ('response' in inputResult) return inputResult.response
          return errorResponse(c, 'validation_failed', 'Request input validation failed', {
            status: 422,
            issues: inputResult.issues,
          })
        }
        const handlerCtx = makeRouteContext(registry, c, inputResult.value, requestId)
        const result = await route.handler(handlerCtx)
        return buildResponse(c, route, result, options)
      })
    } catch (err) {
      logFrameworkError(options.logger, `kata: unhandled error in ${route.method} ${route.path}`, {
        err: serializeError(err),
      })
      shortCircuit = errorResponse(c, 'internal_error', 'Internal server error', { status: 500 })
    }
    // 5. Merge app-level headers, echo the correlation id, and log (#63, #207).
    return finalizeResponse(c, route, requestId, startedAt, shortCircuit, options)
  })
}

/**
 * Handler installed via `app.notFound()` (issue #209). Runs the ADR-0012
 * global middleware chain first — with no per-route `use:`, since there is no
 * matched route — so `cors()` declared as a global still answers an `OPTIONS`
 * preflight itself (Hono's `cors` middleware short-circuits it with a 204)
 * before this ever reaches the 404/405 decision below. Whatever the outcome,
 * it funnels through `finalizeResponse` like every other response.
 */
function buildNotFoundHandler<R extends Registry>(
  app: Hono,
  registry: R,
  pathMethods: Map<string, Set<HttpMethod>>,
  options: RuntimeOptions<R>,
): (c: import('hono').Context) => Promise<Response> {
  return async (c) => {
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER))
    const startedAt = performance.now()
    const method = c.req.method
    const path = c.req.path
    let response: Response | undefined
    try {
      response = await runMiddlewareChain(
        options.middlewares,
        registry,
        c,
        requestId,
        async () => undefined,
      )
    } catch (err) {
      logFrameworkError(
        options.logger,
        `kata: unhandled error in global middleware for ${method} ${path}`,
        {
          err: serializeError(err),
        },
      )
      response = errorResponse(c, 'internal_error', 'Internal server error', { status: 500 })
    }
    response ??= buildNotFoundResponse(c, app, pathMethods, path)
    return (
      finalizeResponse(c, { method, path }, requestId, startedAt, response, options) ?? response
    )
  }
}

/**
 * 404 vs 405 (issue #209). A wrong method on a path some route *does* declare
 * answers 405 with a correct `Allow`; a path nothing declares answers 404 —
 * both through the ADR-0008 envelope. `matchAllowedMethods` does the pattern
 * matching (`:id`, wildcards, …) via Hono's own router rather than
 * string-comparing paths ourselves.
 */
function buildNotFoundResponse(
  c: import('hono').Context,
  app: Hono,
  pathMethods: Map<string, Set<HttpMethod>>,
  path: string,
): Response {
  const allowed = matchAllowedMethods(app, pathMethods, path)
  if (!allowed || allowed.size === 0) {
    return errorResponse(c, 'not_found', 'Route not found', { status: 404 })
  }
  const response = errorResponse(c, 'method_not_allowed', 'Method not allowed', { status: 405 })
  response.headers.set('Allow', HTTP_METHODS.filter((m) => allowed.has(m)).join(', '))
  return response
}

/**
 * Finds the registered route pattern (if any) matching `path` for *some*
 * method, by asking Hono's own router — the same matcher that resolves a
 * real request, so `:id` segments and wildcards behave identically — then
 * looks up that pattern's full method set with a single `Map.get` (the index
 * `registerRoute` built at registration). At most `HTTP_METHODS.length`
 * router probes, a constant independent of how many routes are registered —
 * not a scan over `config.modules`.
 */
function matchAllowedMethods(
  app: Hono,
  pathMethods: Map<string, Set<HttpMethod>>,
  path: string,
): Set<HttpMethod> | undefined {
  for (const candidate of HTTP_METHODS) {
    const [matches] = app.router.match(candidate, path)
    const pattern = matches[0]?.[0]?.[1]?.path
    if (pattern) return pathMethods.get(pattern)
  }
  return undefined
}
