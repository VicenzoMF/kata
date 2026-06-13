import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineContext, singleton } from './context'
import type { Logger } from './logger'
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
