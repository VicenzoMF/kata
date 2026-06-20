import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineContext, scoped, singleton } from './context'
import type { Logger } from './logger'
import { secureHeaders } from './middlewares'
import type { OutputValidationMode } from './output-validation'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type LogCall = {
  level: 'info' | 'warn' | 'error'
  message: string
  extra?: Record<string, unknown>
}

/** A logger that records every call, tagged with the level it was logged at. */
function recordingLogger() {
  const calls: LogCall[] = []
  const push = (level: LogCall['level']) => (message: string, extra?: Record<string, unknown>) => {
    calls.push({ level, message, extra })
  }
  return { calls, info: push('info'), warn: push('warn'), error: push('error') }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ────────────────────────────────────────────────────────────────────────────
// Request id (issue #63)
// ────────────────────────────────────────────────────────────────────────────

describe('request id', () => {
  const k = defineContext({})
  const route = k.defineRoute({
    method: 'GET',
    path: '/whoami',
    input: {},
    output: z.object({ requestId: z.string() }),
    handler: (c) => ({ requestId: c.requestId }),
  })
  const app = k.createApp({ modules: [{ route }] })

  it('exposes a generated UUID on the context and echoes it on the response header', async () => {
    const res = await app.request('/whoami')
    const header = res.headers.get('x-request-id')
    expect(header).toMatch(UUID)
    expect(await res.json()).toEqual({ requestId: header })
  })

  it('reuses a well-formed inbound x-request-id end to end', async () => {
    const res = await app.request('/whoami', { headers: { 'x-request-id': 'trace-abc-123' } })
    expect(res.headers.get('x-request-id')).toBe('trace-abc-123')
    expect(await res.json()).toEqual({ requestId: 'trace-abc-123' })
  })

  it('echoes the request id on error responses too', async () => {
    const errK = defineContext({})
    const bad = errK.defineRoute({
      method: 'GET',
      path: '/bad',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: (c) => c.error('nope', 'no', { status: 422 }),
    })
    const errApp = errK.createApp({ modules: [{ bad }] })
    const res = await errApp.request('/bad', { headers: { 'x-request-id': 'rid-err' } })
    expect(res.status).toBe(422)
    expect(res.headers.get('x-request-id')).toBe('rid-err')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Request logging (issue #63)
// ────────────────────────────────────────────────────────────────────────────

describe('request logging', () => {
  it('logs method, path, status, duration, and request id for a successful request', async () => {
    const logger = recordingLogger()
    const k = defineContext({ logger: singleton<Logger>(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/thing',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })

    const res = await app.request('/thing')

    expect(logger.calls).toHaveLength(1)
    const call = logger.calls[0]!
    expect(call.level).toBe('info')
    expect(call.message).toMatch(/^GET \/thing 200 \d+ms$/)
    expect(call.extra).toMatchObject({
      requestId: res.headers.get('x-request-id'),
      method: 'GET',
      path: '/thing',
      status: 200,
    })
    expect(typeof call.extra?.['durationMs']).toBe('number')
  })

  it('logs a 4xx at warn level', async () => {
    const logger = recordingLogger()
    const k = defineContext({ logger: singleton<Logger>(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/missing',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: (c) => c.error('not_found', 'gone', { status: 404 }),
    })
    await k.createApp({ modules: [{ route }] }).request('/missing')

    expect(logger.calls[0]?.level).toBe('warn')
    expect(logger.calls[0]?.message).toContain('404')
  })

  it('logs a 5xx at error level', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = recordingLogger()
    const k = defineContext({ logger: singleton<Logger>(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/boom',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        throw new Error('kaboom')
      },
    })
    await k.createApp({ modules: [{ route }] }).request('/boom')

    expect(logger.calls[0]?.level).toBe('error')
    expect(logger.calls[0]?.message).toContain('500')
  })

  it('does not log when requestLogging is false', async () => {
    const logger = recordingLogger()
    const k = defineContext({ logger: singleton<Logger>(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/thing',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    await k.createApp({ modules: [{ route }], requestLogging: false }).request('/thing')

    expect(logger.calls).toHaveLength(0)
  })

  it('is a silent no-op when no logger is registered', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/thing',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const res = await k.createApp({ modules: [{ route }] }).request('/thing')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toMatch(UUID)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Output validation mode (issue #17, ADR-0009)
// ────────────────────────────────────────────────────────────────────────────

describe('output validation mode', () => {
  function appWith(mode: OutputValidationMode, handlerReturn: unknown) {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/out',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => handlerReturn as { ok: boolean },
    })
    return k.createApp({ modules: [{ route }], outputValidation: mode, requestLogging: false })
  }

  it('strict: a mismatch is logged and becomes a 500 envelope', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith('strict', { wrong: 'shape' }).request('/out')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'internal_output_shape_mismatch',
      message: 'Response did not match the declared output schema',
    })
    expect(errSpy).toHaveBeenCalled()
  })

  it('log: a mismatch is logged but the handler data passes through with 200', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith('log', { wrong: 'shape' }).request('/out')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wrong: 'shape' })
    expect(errSpy).toHaveBeenCalled()
  })

  it('off: no validation runs — data passes through and nothing is logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith('off', { wrong: 'shape' }).request('/out')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wrong: 'shape' })
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('a valid shape succeeds identically in every mode', async () => {
    const modes: OutputValidationMode[] = ['strict', 'log', 'off']
    const results = await Promise.all(
      modes.map(async (mode) => {
        const res = await appWith(mode, { ok: true }).request('/out')
        return { status: res.status, body: await res.json() }
      }),
    )
    for (const r of results) {
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ ok: true })
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// App-level (global) middleware (issue #86, ADR-0012)
// ────────────────────────────────────────────────────────────────────────────

describe('app-level middleware (ADR-0012)', () => {
  it("runs the global chain before each route's use:, in declared order (onion)", async () => {
    const order: string[] = []
    const k = defineContext({})
    const trace = (label: string) =>
      k.defineMiddleware({
        provides: [],
        handler: async (_c, next) => {
          order.push(`>${label}`)
          await next()
          order.push(`<${label}`)
        },
      })
    const route = k.defineRoute({
      method: 'GET',
      path: '/ordered',
      use: [trace('route-1'), trace('route-2')],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        order.push('handler')
        return { ok: true }
      },
    })
    const app = k.createApp({
      modules: [{ route }],
      middlewares: [trace('global-1'), trace('global-2')],
    })

    const res = await app.request('/ordered')

    expect(res.status).toBe(200)
    // Globals run first (declared order), then the route chain, then the handler;
    // post-`next()` unwinds outermost-last — the standard onion, global outermost.
    expect(order).toEqual([
      '>global-1',
      '>global-2',
      '>route-1',
      '>route-2',
      'handler',
      '<route-2',
      '<route-1',
      '<global-2',
      '<global-1',
    ])
  })

  it('short-circuits when a global middleware returns a Response', async () => {
    const reached: string[] = []
    const k = defineContext({})
    const gate = k.defineMiddleware({
      provides: [],
      handler: (c) => c.error('forbidden', 'No entry', { status: 403 }),
    })
    const laterGlobal = k.defineMiddleware({
      provides: [],
      handler: async (_c, next) => {
        reached.push('later-global')
        await next()
      },
    })
    const routeMw = k.defineMiddleware({
      provides: [],
      handler: async (_c, next) => {
        reached.push('route-mw')
        await next()
      },
    })
    const route = k.defineRoute({
      method: 'GET',
      path: '/guarded',
      use: [routeMw],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        reached.push('handler')
        return { ok: true }
      },
    })
    const app = k.createApp({ modules: [{ route }], middlewares: [gate, laterGlobal] })

    const res = await app.request('/guarded')

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'No entry' })
    // Later globals, the whole route chain, and the handler are all skipped.
    expect(reached).toEqual([])
    // The short-circuit still funnels through finalizeResponse — x-request-id echo.
    expect(res.headers.get('x-request-id')).toMatch(UUID)
  })

  it('makes a scoped slot a global middleware provides readable in every handler', async () => {
    const k = defineContext({ user: scoped<{ id: string }>() })
    const auth = k.defineMiddleware({
      provides: ['user'] as const,
      handler: async (c, next) => {
        c.set('user', { id: 'u-42' })
        await next()
      },
    })
    // Neither route lists `auth` in `use:` — the slot is provided only by the
    // global chain, yet readable in both handlers via the shared scoped store.
    const me = k.defineRoute({
      method: 'GET',
      path: '/me',
      input: {},
      output: z.object({ id: z.string() }),
      handler: (c) => ({ id: c.get('user').id }),
    })
    const echo = k.defineRoute({
      method: 'GET',
      path: '/echo-user',
      input: {},
      output: z.object({ id: z.string() }),
      handler: (c) => ({ id: c.get('user').id }),
    })
    const app = k.createApp({ modules: [{ me, echo }], middlewares: [auth] })

    const results = await Promise.all(
      ['/me', '/echo-user'].map(async (path) => {
        const res = await app.request(path)
        return { status: res.status, body: await res.json() }
      }),
    )
    for (const r of results) {
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ id: 'u-42' })
    }
  })

  it('exposes a global-provided slot to a later route middleware too', async () => {
    const k = defineContext({ user: scoped<{ id: string }>() })
    const auth = k.defineMiddleware({
      provides: ['user'] as const,
      handler: async (c, next) => {
        c.set('user', { id: 'u-7' })
        await next()
      },
    })
    let seenByRouteMw: string | undefined
    const readUser = k.defineMiddleware({
      provides: [],
      handler: async (c, next) => {
        seenByRouteMw = c.get('user').id
        await next()
      },
    })
    const route = k.defineRoute({
      method: 'GET',
      path: '/chain-read',
      use: [readUser],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }], middlewares: [auth] })

    const res = await app.request('/chain-read')

    expect(res.status).toBe(200)
    expect(seenByRouteMw).toBe('u-7')
  })

  it('applies a hardening middleware declared globally to every route', async () => {
    const k = defineContext({})
    const a = k.defineRoute({
      method: 'GET',
      path: '/a',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const b = k.defineRoute({
      method: 'GET',
      path: '/b',
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    // secureHeaders() declares provides: [] — the canonical declare-once case,
    // and not blocked on the #88 lint change (per ADR-0012).
    const app = k.createApp({ modules: [{ a, b }], middlewares: [secureHeaders()] })

    const results = await Promise.all(
      ['/a', '/b'].map(async (path) => {
        const res = await app.request(path)
        return {
          status: res.status,
          nosniff: res.headers.get('x-content-type-options'),
          frame: res.headers.get('x-frame-options'),
        }
      }),
    )
    for (const r of results) {
      expect(r.status).toBe(200)
      expect(r.nosniff).toBe('nosniff')
      expect(r.frame).toBe('SAMEORIGIN')
    }
  })

  it('runs only the route use: chain when middlewares is omitted', async () => {
    const order: string[] = []
    const k = defineContext({})
    const routeMw = k.defineMiddleware({
      provides: [],
      handler: async (_c, next) => {
        order.push('route-mw')
        await next()
      },
    })
    const route = k.defineRoute({
      method: 'GET',
      path: '/plain',
      use: [routeMw],
      input: {},
      output: z.object({ ok: z.boolean() }),
      handler: () => {
        order.push('handler')
        return { ok: true }
      },
    })
    const app = k.createApp({ modules: [{ route }] })

    const res = await app.request('/plain')

    expect(res.status).toBe(200)
    expect(order).toEqual(['route-mw', 'handler'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Input validation (issue #152)
// ────────────────────────────────────────────────────────────────────────────

describe('input validation (body parsing)', () => {
  it('returns 400 for a malformed JSON body when body schema is required', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/malformed',
      input: { body: z.object({ foo: z.string() }) },
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })

    const res = await app.request('/malformed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ malformed',
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({
      error: 'validation_failed',
      message: 'Malformed JSON body',
      issues: {
        body: [{ path: '', message: 'Request body is not valid JSON', code: 'custom' }],
      },
    })
  })

  it('leaves an empty body as undefined, allowing optional body schemas to pass', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/empty-optional',
      input: { body: z.object({ foo: z.string() }).optional() },
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })

    const res = await app.request('/empty-optional', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  it('returns 422 for a missing body when body schema is required', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/empty-required',
      input: { body: z.object({ foo: z.string() }) },
      output: z.object({ ok: z.boolean() }),
      handler: () => ({ ok: true }),
    })
    const app = k.createApp({ modules: [{ route }] })

    const res = await app.request('/empty-required', { method: 'POST' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toEqual(
      expect.objectContaining({
        error: 'validation_failed',
      }),
    )
  })
})
