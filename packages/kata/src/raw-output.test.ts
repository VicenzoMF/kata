import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineContext, raw, singleton } from './context'
import { ErrorBodySchema } from './errors'
import type { Logger } from './logger'
import type { OutputValidationMode } from './output-validation'
import type { ModulesToHonoSchema } from './rpc'

// Most tests here exercise a non-strict mode against a route with no logger,
// which fires the registration-time "body is unchecked" warning (by design —
// covered explicitly below) on `console.warn`; silence it everywhere else.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function recordingLogger(): Logger & { calls: Array<{ level: string; message: string }> } {
  const calls: Array<{ level: string; message: string }> = []
  return {
    calls,
    info: (message) => calls.push({ level: 'info', message }),
    warn: (message) => calls.push({ level: 'warn', message }),
    error: (message) => calls.push({ level: 'error', message }),
  }
}

/**
 * A response whose `.clone()` — the operation that actually buffers a body
 * (`clone().text()`) — is spied, so a test can assert kata did or did not
 * attempt to buffer it. A `ReadableStream`'s `pull` fires eagerly to fill its
 * queue on construction regardless of whether anything reads it, so tracking
 * `.clone()` is the precise signal, not the stream itself.
 */
function trackedResponse(
  text: string,
  contentType: string,
  status = 200,
): { response: Response; wasCloned: () => boolean } {
  const response = new Response(text, { status, headers: { 'content-type': contentType } })
  const cloneSpy = vi.spyOn(response, 'clone')
  return { response, wasCloned: () => cloneSpy.mock.calls.length > 0 }
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime — raw() content-type + body validation (ADR-0024)
// ────────────────────────────────────────────────────────────────────────────

describe('raw() output: content-type + body validation', () => {
  function appWith(mode: OutputValidationMode, handler: () => Response, logger?: Logger) {
    const k = defineContext(logger ? { logger: singleton(logger) } : {})
    const route = k.defineRoute({
      method: 'GET',
      path: '/export.csv',
      input: {},
      output: raw('text/csv', z.string()),
      handler,
    })
    return k.createApp({ modules: [{ route }], outputValidation: mode, requestLogging: false })
  }

  it('strict: a matching content-type and body passes through unchanged', async () => {
    const app = appWith(
      'strict',
      () => new Response('id,name\n1,Ada', { headers: { 'content-type': 'text/csv' } }),
    )
    const res = await app.request('/export.csv')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv')
    expect(await res.text()).toBe('id,name\n1,Ada')
  })

  it('strict: ignores content-type parameters like charset when comparing', async () => {
    const app = appWith(
      'strict',
      () => new Response('csv', { headers: { 'content-type': 'text/csv; charset=utf-8' } }),
    )
    const res = await app.request('/export.csv')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('csv')
  })

  it('strict: a content-type mismatch 500s and logs, without buffering the body', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { response, wasCloned } = trackedResponse('id,name\n1,Ada', 'application/json')
    const app = appWith('strict', () => response)
    const res = await app.request('/export.csv')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'internal_output_shape_mismatch',
      message: 'Response did not match the declared output schema',
    })
    expect(errSpy).toHaveBeenCalled()
    expect(wasCloned()).toBe(false)
  })

  it('log: a content-type mismatch is logged but the original response is served', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = appWith(
      'log',
      () => new Response('id,name\n1,Ada', { headers: { 'content-type': 'application/json' } }),
    )
    const res = await app.request('/export.csv')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('id,name\n1,Ada')
    expect(errSpy).toHaveBeenCalled()
  })

  it('off: skips both the content-type and body check', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = appWith(
      'off',
      () => new Response('nope', { headers: { 'content-type': 'application/json' } }),
    )
    const res = await app.request('/export.csv')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('nope')
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('strict: a body that fails the declared schema 500s', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/export.csv',
      input: {},
      output: raw('text/csv', z.string().min(100)), // no real body is this long
      handler: () => new Response('short', { headers: { 'content-type': 'text/csv' } }),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/export.csv')

    expect(res.status).toBe(500)
    expect(errSpy).toHaveBeenCalled()
  })
})

describe('raw() output: the body is never buffered outside strict mode (ADR-0024)', () => {
  it('log: content-type matches — the body is never cloned/buffered', async () => {
    const { response, wasCloned } = trackedResponse('a huge csv file', 'text/csv')
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/download',
      input: {},
      output: raw('text/csv', z.string()),
      handler: () => response,
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'log',
      requestLogging: false,
    })
    const res = await app.request('/download')

    expect(res.status).toBe(200)
    expect(wasCloned()).toBe(false)
  })

  it('strict: content-type matches — the body is cloned once to validate it', async () => {
    const { response, wasCloned } = trackedResponse('a small csv file', 'text/csv')
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/download',
      input: {},
      output: raw('text/csv', z.string()),
      handler: () => response,
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/download')

    expect(res.status).toBe(200)
    expect(wasCloned()).toBe(true)
  })
})

describe('raw() output: startup diagnostic for unvalidated bodies (ADR-0024)', () => {
  it('warns once at registration (not per request) when the mode will never check the body', async () => {
    const logger = recordingLogger()
    const k = defineContext({ logger: singleton(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/export.csv',
      input: {},
      output: raw('text/csv', z.string()),
      handler: () => new Response('a,b', { headers: { 'content-type': 'text/csv' } }),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'log',
      requestLogging: false,
    })

    const warnings = logger.calls.filter((c) => c.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('GET /export.csv')
    expect(warnings[0]?.message).toContain("'strict'")

    await app.request('/export.csv')
    await app.request('/export.csv')

    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(1)
  })

  it('does not warn when the mode is strict (the body is actually checked)', () => {
    const logger = recordingLogger()
    const k = defineContext({ logger: singleton(logger) })
    const route = k.defineRoute({
      method: 'GET',
      path: '/export.csv',
      input: {},
      output: raw('text/csv', z.string()),
      handler: () => new Response('a,b', { headers: { 'content-type': 'text/csv' } }),
    })
    k.createApp({ modules: [{ route }], outputValidation: 'strict', requestLogging: false })

    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(0)
  })
})

describe('raw() output: mixed with a JSON status in the map form', () => {
  it('a JSON 404 and a raw 200 validate independently on the same route', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/export.csv',
      input: {},
      output: { 200: raw('text/csv', z.string()), 404: ErrorBodySchema },
      handler: (c) => c.error('not_found', 'nothing to export', { status: 404 }),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/export.csv')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found', message: 'nothing to export' })
    expect(errSpy).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Type-level — RouteHandlerReturn + the RPC `Schema` derivation (ADR-0024)
// ────────────────────────────────────────────────────────────────────────────

const proofCtx = defineContext({})

const rawRoute = proofCtx.defineRoute({
  method: 'GET',
  path: '/export.csv',
  input: {},
  output: raw('text/csv', z.string()),
  // @ts-expect-error — a raw() entry has no plain-value equivalent; only a
  // Response satisfies it (ADR-0024).
  handler: () => 'id,name\n1,Ada',
})
void rawRoute

const rawRouteOk = proofCtx.defineRoute({
  method: 'GET',
  path: '/export.csv',
  input: {},
  output: raw('text/csv', z.string()),
  handler: () => new Response('id,name\n1,Ada', { headers: { 'content-type': 'text/csv' } }),
})

type RawModules = readonly [{ rawRouteOk: typeof rawRouteOk }]
type RawGet = ModulesToHonoSchema<RawModules>['/export.csv']['$get']

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export type Adr0022RpcProofs = [
  Expect<Equal<RawGet['outputFormat'], 'text'>>,
  Expect<Equal<RawGet['output'], string>>,
  Expect<Equal<RawGet['status'], 200>>,
]
