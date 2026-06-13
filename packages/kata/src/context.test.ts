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
