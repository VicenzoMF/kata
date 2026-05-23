import type { Hono } from 'hono'
import { Hono as HonoApp } from 'hono'
import type { z } from 'zod'

import type { FieldIssue } from './errors'
import { formatZodIssues } from './errors'
import type { Registry, ResolvedValue, Scoped, ScopedKeys, Singleton } from './types'

// ────────────────────────────────────────────────────────────────────────────
// Slot constructors (top-level — used to build the registry)
// ────────────────────────────────────────────────────────────────────────────

export function singleton<T>(value: T): Singleton<T> {
  return { __value: value, __kind: 'singleton' } as unknown as Singleton<T>
}

export function scoped<T>(): Scoped<T> {
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
   * NOTE (ADR-0004 follow-up): in v1 `get` types all registered keys including
   * scoped ones. Whether a scoped key was actually provided by the route's
   * middleware chain is enforced by the `kata/scoped-slot-not-provided` lint
   * rule (to be implemented), not by the type system. Tightening this to
   * compile-time inference is a planned follow-up.
   */
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  input: InferInput<I>
  raw: import('hono').Context
  json<T>(value: T, status?: number): Response
}

export type RouteHandlerReturn<O extends z.ZodTypeAny> = z.infer<O> | Response

export type Route<R extends Registry> = {
  readonly __kata: 'route'
  readonly method: HttpMethod
  readonly path: string
  readonly use: readonly Middleware<R>[]
  readonly input: InputSchemas
  readonly output: z.ZodTypeAny
  readonly handler: (c: RouteContext<R, InputSchemas>) => Promise<unknown> | unknown
}

export type Module<R extends Registry> = Readonly<Record<string, Route<R>>>

export type AppConfig<R extends Registry> = {
  modules: readonly Module<R>[]
}

// ────────────────────────────────────────────────────────────────────────────
// defineContext — returns the typed factory
// ────────────────────────────────────────────────────────────────────────────

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

  function defineRoute<const I extends InputSchemas, const O extends z.ZodTypeAny>(config: {
    method: HttpMethod
    path: string
    use?: readonly Middleware<R>[]
    input: I
    output: O
    handler: (c: RouteContext<R, I>) => Promise<RouteHandlerReturn<O>> | RouteHandlerReturn<O>
  }): Route<R> {
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

  function createApp(config: AppConfig<R>): Hono {
    return buildHonoApp(registry, config)
  }

  return { registry, defineMiddleware, defineRoute, createApp } as const
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime — build Hono app from modules
// ────────────────────────────────────────────────────────────────────────────

function buildHonoApp<R extends Registry>(registry: R, config: AppConfig<R>): Hono {
  const app = new HonoApp()
  for (const mod of config.modules) {
    for (const route of Object.values(mod)) {
      registerRoute(app, registry, route)
    }
  }
  return app
}

const SCOPED_STORE = Symbol('kata.scoped-store')

function getScopedStore(c: import('hono').Context): Map<string, unknown> {
  let store = c.get(SCOPED_STORE as never) as Map<string, unknown> | undefined
  if (!store) {
    store = new Map<string, unknown>()
    c.set(SCOPED_STORE as never, store as never)
  }
  return store
}

function makeMiddlewareContext<R extends Registry>(
  registry: R,
  c: import('hono').Context,
): MiddlewareContext<R> {
  const store = getScopedStore(c)
  return {
    get(key) {
      const slot = registry[key as string]
      if (!slot) throw new Error(`kata: key '${String(key)}' not registered in defineContext`)
      if (slot.__kind === 'singleton') return (slot as Singleton<unknown>).__value as never
      if (!store.has(key as string)) {
        throw new Error(
          `kata: scoped slot '${String(key)}' read before being set. Did the providing middleware run?`,
        )
      }
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
    json: (value, status) => c.json(value as never, (status ?? 200) as never),
  }
}

function makeRouteContext<R extends Registry, I extends InputSchemas>(
  registry: R,
  c: import('hono').Context,
  input: InferInput<I>,
): RouteContext<R, I> {
  const store = getScopedStore(c)
  return {
    get(key) {
      const slot = registry[key as string]
      if (!slot) throw new Error(`kata: key '${String(key)}' not registered in defineContext`)
      if (slot.__kind === 'singleton') return (slot as Singleton<unknown>).__value as never
      if (!store.has(key as string)) {
        throw new Error(
          `kata: scoped slot '${String(key)}' read before being set. Did the providing middleware run?`,
        )
      }
      return store.get(key as string) as never
    },
    input,
    raw: c,
    json: (value, status) => c.json(value as never, (status ?? 200) as never),
  }
}

async function readInputs<I extends InputSchemas>(
  input: I,
  c: import('hono').Context,
): Promise<
  { ok: true; value: InferInput<I> } | { ok: false; issues: Record<string, FieldIssue[]> }
> {
  const raw: Record<string, unknown> = {}
  if (input.params) raw['params'] = c.req.param()
  if (input.query) raw['query'] = c.req.query()
  if (input.body) {
    try {
      raw['body'] = await c.req.json()
    } catch {
      raw['body'] = undefined
    }
  }
  if (input.headers) {
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

function registerRoute<R extends Registry>(app: Hono, registry: R, route: Route<R>): void {
  const method = route.method.toLowerCase() as Lowercase<HttpMethod>
  // Hono router: app.get(path, ...handlers)
  const register = (app as unknown as Record<string, (path: string, ...h: unknown[]) => unknown>)[
    method
  ]
  if (!register) throw new Error(`kata: Hono does not support method '${route.method}'`)
  register.call(app, route.path, async (c: import('hono').Context) => {
    // 1. Run middleware chain manually (Hono's native middleware would also work,
    //    but threading the kata context is cleaner this way).
    let i = 0
    let shortCircuit: Response | undefined
    const runChain = async (): Promise<void> => {
      if (i >= route.use.length) {
        // 2. Validate input
        const inputResult = await readInputs(route.input, c)
        if (!inputResult.ok) {
          shortCircuit = c.json({ error: 'validation_failed', issues: inputResult.issues }, 422)
          return
        }
        // 3. Run handler
        const handlerCtx = makeRouteContext(registry, c, inputResult.value)
        const result = await route.handler(handlerCtx)
        if (result instanceof Response) {
          shortCircuit = result
          return
        }
        // 4. Validate output (ADR-0003)
        const outputResult = route.output.safeParse(result)
        if (!outputResult.success) {
          console.error(
            `kata: output schema mismatch in ${route.method} ${route.path}`,
            outputResult.error.issues,
          )
          shortCircuit = c.json({ error: 'internal_output_shape_mismatch' }, 500)
          return
        }
        shortCircuit = c.json(outputResult.data as never)
        return
      }
      const mw = route.use[i++]!
      const mwCtx = makeMiddlewareContext(registry, c)
      const result = await mw.handler(mwCtx, runChain)
      if (result instanceof Response) {
        shortCircuit = result
      }
    }
    await runChain()
    return shortCircuit
  })
}
