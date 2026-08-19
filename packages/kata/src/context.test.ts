import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineContext, scoped, singleton } from './context'
import { cors } from './middlewares/cors'
import { secureHeaders } from './middlewares/secure-headers'
import type { Singleton } from './types'

describe('singleton()', () => {
  it('wraps a value with the singleton kind', () => {
    const slot = singleton(42)
    expect((slot as unknown as Singleton<number>).__kind).toBe('singleton')
    expect((slot as unknown as Singleton<number>).__value).toBe(42)
  })
})

describe('scoped()', () => {
  it('produces a scoped marker without a value', () => {
    const slot = scoped<{ id: string }>()
    expect((slot as { __kind: string }).__kind).toBe('scoped')
  })
})

describe('defineContext()', () => {
  const k = defineContext({
    counter: singleton(0),
    user: scoped<{ id: string }>(),
  })

  it('returns the registry unchanged', () => {
    expect(k.registry.counter).toBeDefined()
    expect(k.registry.user).toBeDefined()
  })

  it('exposes defineRoute, defineMiddleware, createApp', () => {
    expect(typeof k.defineRoute).toBe('function')
    expect(typeof k.defineMiddleware).toBe('function')
    expect(typeof k.createApp).toBe('function')
  })

  it('defineMiddleware tags the result and preserves provides', () => {
    const mw = k.defineMiddleware({
      provides: ['user'] as const,
      handler: async (_c, next) => {
        await next()
      },
    })
    expect(mw.__kata).toBe('middleware')
    expect(mw.provides).toEqual(['user'])
  })

  it('resolve returns a singleton value outside a request', () => {
    const logger = { info: () => {} }
    const app = defineContext({ counter: singleton(7), logger: singleton(logger) })
    expect(app.resolve('counter')).toBe(7)
    expect(app.resolve('logger')).toBe(logger)
  })

  it('resolve throws for an unregistered key', () => {
    // @ts-expect-error — 'missing' is not a registered singleton key.
    expect(() => k.resolve('missing')).toThrow(/not registered/)
  })

  it('resolve throws when the key is a scoped slot', () => {
    // `user` is scoped, so it has no value outside a request. The type bound
    // (SingletonKeys) already forbids it; the directive proves the runtime guard.
    // @ts-expect-error — exercising the runtime guard the types prevent.
    expect(() => k.resolve('user')).toThrow(/only singleton slots/)
  })

  it('defineRoute tags the result and preserves method/path/use', () => {
    const route = k.defineRoute({
      method: 'GET',
      path: '/x',
      input: {},
      output: z.object({}),
      handler: () => ({}),
    })
    expect(route.__kata).toBe('route')
    expect(route.method).toBe('GET')
    expect(route.path).toBe('/x')
    expect(route.use).toEqual([])
  })
})

describe('c.error() helper (ADR-0008)', () => {
  const k = defineContext({})

  it('serialises the unified envelope with the status carried in extra', async () => {
    // Map form (ADR-0011): a bare Response against a plain Zod output no
    // longer bypasses validation (ADR-0022), so a route that returns
    // `c.error` for a status other than its 200 declares that status here.
    const route = k.defineRoute({
      method: 'GET',
      path: '/missing',
      input: {},
      output: { 200: z.object({ ok: z.boolean() }) },
      handler: (c) => c.error('not_found', 'User not found', { status: 404 }),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/missing')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'not_found', message: 'User not found' })
  })

  it('defaults to status 400 when extra omits a status', async () => {
    const route = k.defineRoute({
      method: 'GET',
      path: '/bad',
      input: {},
      output: { 200: z.object({ ok: z.boolean() }) },
      handler: (c) => c.error('bad_request', 'Nope'),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/bad')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_request', message: 'Nope' })
  })
})

describe('global error boundary (#62)', () => {
  const k = defineContext({})

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('funnels a thrown handler error into the unified 5xx envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const route = k.defineRoute({
      method: 'GET',
      path: '/boom',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new Error('handler exploded')
      },
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })
  })

  it('funnels a thrown middleware error into the unified 5xx envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const boomMw = k.defineMiddleware({
      provides: [],
      handler: () => {
        throw new Error('middleware exploded')
      },
    })
    const route = k.defineRoute({
      method: 'GET',
      path: '/mw-boom',
      use: [boomMw],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/mw-boom')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })
  })

  it('app.onError catches errors thrown outside the kata route pipeline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = k.createApp({ modules: [] })
    // A raw Hono route bypasses registerRoute's try/catch — only the
    // app.onError fallback can catch a throw here.
    app.get('/raw-boom', () => {
      throw new Error('raw exploded')
    })
    const res = await app.request('/raw-boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' })
  })

  it('logs the real error server-side but never leaks it to the client', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const route = k.defineRoute({
      method: 'GET',
      path: '/secret-boom',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new Error('DB password is hunter2')
      },
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/secret-boom')

    expect(JSON.stringify(await res.json())).not.toContain('hunter2')
    expect(errSpy).toHaveBeenCalled()
    const loggedTheRealError = errSpy.mock.calls.some(([, extra]) =>
      (extra as { err?: { message?: string } } | undefined)?.err?.message?.includes('hunter2'),
    )
    expect(loggedTheRealError).toBe(true)
  })
})

describe('scoped slot access errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The thrown error is funnelled into the 5xx envelope and logged server-side
  // as a serialised `{ err }` (issue #210), never a raw `Error` instance; read
  // the flattened `err.message` to check the thrown message.
  const thrownError = (errSpy: { mock: { calls: unknown[][] } }): { message: string } | undefined =>
    errSpy.mock.calls
      .map(([, extra]) => (extra as { err?: { message: string } } | undefined)?.err)
      .find((err): err is { message: string } => err !== undefined)

  it('throws "read before being set" when a route reads a scoped slot never provided', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({ user: scoped<{ id: string }>() })
    const route = k.defineRoute({
      method: 'GET',
      path: '/early-read',
      input: {},
      output: z.object({ id: z.string() }),
      // No middleware provides `user`, so the slot is read before it is set.
      handler: (c) => ({ id: c.get('user').id }),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/early-read')

    expect(res.status).toBe(500)
    expect(thrownError(errSpy)?.message).toContain('read before being set')
  })

  it('throws "read before being set" when a middleware reads a scoped slot never provided', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({ user: scoped<{ id: string }>() })
    const readEarly = k.defineMiddleware({
      provides: [],
      handler: async (c, next) => {
        c.get('user') // reads the scoped slot before any middleware sets it
        await next()
      },
    })
    const route = k.defineRoute({
      method: 'GET',
      path: '/early-read-mw',
      use: [readEarly],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/early-read-mw')

    expect(res.status).toBe(500)
    expect(thrownError(errSpy)?.message).toContain('read before being set')
  })

  it('throws "not a scoped slot" when c.set() targets a singleton key', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({ counter: singleton(0), user: scoped<{ id: string }>() })
    const badSet = k.defineMiddleware({
      provides: [],
      handler: async (c, next) => {
        // `counter` is a singleton, not a scoped slot — set() must reject it at
        // runtime. The type system already forbids it (set() is keyed to
        // ScopedKeys), so the directive both proves and suppresses that.
        // @ts-expect-error — exercising the runtime guard the types prevent.
        c.set('counter', 99)
        await next()
      },
    })
    const route = k.defineRoute({
      method: 'GET',
      path: '/bad-set',
      use: [badSet],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/bad-set')

    expect(res.status).toBe(500)
    expect(thrownError(errSpy)?.message).toContain('not a scoped slot')
  })
})

describe('unhandled errors reach the logger pre-flattened (issue #210)', () => {
  // The exact failure mode issue #210 reports: `JSON.stringify(new Error(...))`
  // is `"{}"` because `message`/`stack` are non-enumerable, so a logger this
  // naive is the regression test — if the framework ever hands it a raw
  // `Error` again, the log line silently loses everything but comes back.
  function naiveJsonLogger() {
    const lines: string[] = []
    const write = (message: string, extra?: object) => {
      lines.push(JSON.stringify({ message, ...extra }))
    }
    return { lines, logger: { info: write, warn: write, error: write } }
  }

  it('a route that throws logs name, message and stack under a naive JSON.stringify logger', async () => {
    const { lines, logger } = naiveJsonLogger()
    const k = defineContext({ logger: singleton(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/boom',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new Error('handler exploded')
      },
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    const errorLine = lines.map((line) => JSON.parse(line)).find((line) => line.err)
    expect(errorLine.err).toMatchObject({ name: 'Error', message: 'handler exploded' })
    expect(typeof errorLine.err.stack).toBe('string')
  })

  it('serialises a `cause` chain and an AggregateError without crashing the logger', async () => {
    const { lines, logger } = naiveJsonLogger()
    const k = defineContext({ logger: singleton(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/boom',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new AggregateError(
          [new Error('leaf one'), new Error('leaf two', { cause: new Error('root') })],
          'multiple failures',
        )
      },
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    const errorLine = lines.map((line) => JSON.parse(line)).find((line) => line.err)
    expect(errorLine.err.errors).toHaveLength(2)
    expect(errorLine.err.errors[0]).toMatchObject({ name: 'Error', message: 'leaf one' })
    expect(errorLine.err.errors[1].cause).toMatchObject({ name: 'Error', message: 'root' })
  })

  it('a non-Error throw does not crash the logger', async () => {
    const { lines, logger } = naiveJsonLogger()
    const k = defineContext({ logger: singleton(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/boom',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw 'a string, not an Error'
      },
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    const errorLine = lines.map((line) => JSON.parse(line)).find((line) => line.err)
    expect(errorLine.err).toEqual({ name: 'string', message: 'a string, not an Error' })
  })
})

describe('finalizeResponse with an immutable Response (issue #207)', () => {
  it('rebuilds rather than skips the x-request-id echo when headers are immutable', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/frozen',
      input: {},
      // Map form (ADR-0011): 302 isn't declared, so a bare Response is still
      // allowed here (ADR-0022 only tightens the plain 200 schema).
      output: { 200: z.object({ ok: z.boolean() }) },
      // `Response.redirect()` yields immutable headers — like a Response handed
      // back straight from `fetch()`. finalizeResponse must rebuild rather than
      // throw or silently drop the correlation-id header.
      handler: () => Response.redirect('https://example.test/elsewhere', 302),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/frozen')

    expect(res.status).toBe(302)
    expect(res.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(res.headers.get('location')).toBe('https://example.test/elsewhere')
  })

  it('streams the body through the rebuild rather than buffering it', async () => {
    // A stream that stalls (enqueues nothing) until `released` flips. A
    // `ReadableStream` calls `pull` once on its own right after construction
    // to try to fill its queue — that alone must not be mistaken for a read,
    // so the first pull staying a no-op is expected, not a bug. What proves
    // "not buffered" is that `app.request()` below resolves while still
    // stalled: `await response.text()` would hang forever waiting for the
    // stream to close, so the request finishing means kata never called it.
    let released = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!released) return
        controller.enqueue(new TextEncoder().encode('chunk'))
        controller.close()
      },
    })
    // A minimal Headers-shaped object (not a real `Headers` — wrapping a real
    // one in a Proxy breaks undici's private-field internals) whose mutators
    // throw `TypeError`, the way genuinely immutable headers do (e.g. `fetch()`
    // responses on Cloudflare Workers). Reads stay real so the rebuild's
    // `new Headers(response.headers)` copy can iterate it.
    const store = new Map([['content-type', 'application/octet-stream']])
    const throwImmutable = (): never => {
      throw new TypeError('immutable headers')
    }
    const frozenHeaders = {
      set: throwImmutable,
      append: throwImmutable,
      delete: throwImmutable,
      has: (name: string) => store.has(name.toLowerCase()),
      get: (name: string) => store.get(name.toLowerCase()) ?? null,
      getSetCookie: () => [] as string[],
      [Symbol.iterator]: () => store.entries(),
    } as unknown as Headers
    const immutable = new Response(body, { status: 200 })
    Object.defineProperty(immutable, 'headers', { get: () => frozenHeaders })

    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/stream',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => immutable,
    })
    // Output validation is unrelated to what this test exercises (the header
    // merge/rebuild seam), and would itself buffer the body to check it
    // (ADR-0022) — turned off so only the rebuild path under test touches the
    // stream. `{ ok: boolean }` also happens to structurally overlap `Response`
    // (which has a real `ok` property), a known structural-typing caveat
    // (ADR-0022) that lets a bare Response through a plain schema undetected.
    const app = k.createApp({ modules: [{ route }], outputValidation: 'off' })
    // Resolves without ever releasing the stall — proof the rebuild passed
    // `response.body` through untouched instead of awaiting it to completion.
    const res = await app.request('/stream')

    expect(res.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    released = true
    expect(await res.text()).toBe('chunk')
  })
})

describe('notFound / unmatched routes (issue #209)', () => {
  const k = defineContext({})

  function makeApp(middlewares?: Parameters<typeof k.createApp>[0]['middlewares']) {
    const route = k.defineRoute({
      method: 'GET',
      path: '/orgs/:id',
      input: {},
      output: z.object({ id: z.string() }),
      handler: (c) => ({ id: c.raw.req.param('id') ?? '' }),
    })
    const other = k.defineRoute({
      method: 'POST',
      path: '/orgs/:id',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    return k.createApp({ modules: [{ route, other }], middlewares })
  }

  it('a genuinely unmatched path answers the ADR-0008 404 envelope with x-request-id', async () => {
    const app = makeApp()
    const res = await app.request('/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'not_found', message: 'Route not found' })
    expect(res.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('a wrong method on a registered path answers 405 with a correct Allow header', async () => {
    const app = makeApp()
    const res = await app.request('/orgs/5', { method: 'DELETE' })

    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, POST')
    expect(await res.json()).toEqual({ error: 'method_not_allowed', message: 'Method not allowed' })
  })

  it('matches the registered path *pattern*, not the literal string — a param path still 405s correctly', async () => {
    const app = makeApp()
    const res = await app.request('/orgs/abc-123', { method: 'PATCH' })

    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, POST')
  })

  it('a registered method on the registered path is unaffected', async () => {
    const app = makeApp()
    const res = await app.request('/orgs/5')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '5' })
  })

  it('emits a request log line for an unmatched path', async () => {
    const lines: unknown[] = []
    const logger = {
      info: () => {},
      warn: (msg: string, meta?: object) => lines.push({ msg, ...meta }),
      error: () => {},
    }
    const withLogger = defineContext({ logger: singleton(logger) })
    const route = withLogger.defineRoute({
      method: 'GET',
      path: '/x',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = withLogger.createApp({ modules: [{ route }] })
    await app.request('/nope')

    expect(lines).toEqual([expect.objectContaining({ method: 'GET', path: '/nope', status: 404 })])
  })

  it('carries the app-level security headers declared as an ADR-0012 global', async () => {
    const app = makeApp([secureHeaders()])
    const res = await app.request('/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('an ADR-0012 global cors() answers an OPTIONS preflight itself, before the 405 path', async () => {
    const app = makeApp([cors({ origin: 'https://example.com' })])
    const res = await app.request('/orgs/5', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com')
  })

  it('OPTIONS on a known path still 405s when no CORS middleware is configured', async () => {
    const app = makeApp()
    const res = await app.request('/orgs/5', { method: 'OPTIONS' })

    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, POST')
  })
})
