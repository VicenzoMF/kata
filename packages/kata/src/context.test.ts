import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineContext, scoped, singleton } from './context'
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
    const route = k.defineRoute({
      method: 'GET',
      path: '/missing',
      input: {},
      output: z.object({ ok: z.boolean() }),
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
      output: z.object({ ok: z.boolean() }),
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
    const loggedTheRealError = errSpy.mock.calls
      .flat()
      .some((arg) => arg instanceof Error && arg.message.includes('hunter2'))
    expect(loggedTheRealError).toBe(true)
  })
})

describe('scoped slot access errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The thrown error is funnelled into the 5xx envelope and the original is
  // logged server-side; assert on the logged Error to check the thrown message.
  const thrownError = (errSpy: { mock: { calls: unknown[][] } }): Error | undefined =>
    errSpy.mock.calls.flat().find((arg): arg is Error => arg instanceof Error)

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

describe('finalizeResponse with an immutable Response', () => {
  it('skips the x-request-id echo instead of throwing when headers are immutable', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/frozen',
      input: {},
      output: z.object({ ok: z.boolean() }),
      // `Response.redirect()` yields immutable headers — like a Response handed
      // back straight from `fetch()`. finalizeResponse must not throw trying to
      // set the correlation-id header on it.
      handler: () => Response.redirect('https://example.test/elsewhere', 302),
    })
    const app = k.createApp({ modules: [{ route }] })
    const res = await app.request('/frozen')

    // No throw into the 5xx funnel: the original redirect passes through, and
    // the header was skipped (immutable) rather than set.
    expect(res.status).toBe(302)
    expect(res.headers.get('x-request-id')).toBeNull()
    expect(res.headers.get('location')).toBe('https://example.test/elsewhere')
  })
})
