import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineContext } from '../context'
import { bodyLimit, DEFAULT_MAX_BODY_SIZE } from './body-limit'
import { cors } from './cors'
import { secureHeaders } from './secure-headers'

// A minimal kata app with one POST /echo route, parameterised by the `use`
// chain under test. Exercised through Hono's `app.request()` — no live server.
const k = defineContext({})
const { defineRoute, createApp } = k
type UseChain = NonNullable<Parameters<typeof k.defineRoute>[0]['use']>

function buildApp(use: UseChain) {
  const echo = defineRoute({
    method: 'POST',
    path: '/echo',
    use,
    input: { body: z.object({ msg: z.string() }) },
    output: z.object({ msg: z.string() }),
    handler: (c) => c.input.body,
  })
  return createApp({ modules: [{ echo }] })
}

function post(use: UseChain, body: unknown, headers: Record<string, string> = {}) {
  return buildApp(use).request('/echo', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('cors()', () => {
  it('sets Access-Control-Allow-Origin: * by default and passes the request through', async () => {
    const res = await post([cors()], { msg: 'hi' })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({ msg: 'hi' })
  })

  it('echoes a matching configured origin', async () => {
    const res = await post(
      [cors({ origin: 'https://example.com' })],
      { msg: 'hi' },
      {
        origin: 'https://example.com',
      },
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://example.com')
  })
})

describe('secureHeaders()', () => {
  it('applies the hardened baseline headers', async () => {
    const res = await post([secureHeaders()], { msg: 'hi' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains')
  })

  it('lets an individual header be disabled via options', async () => {
    const res = await post([secureHeaders({ xFrameOptions: false })], { msg: 'hi' })
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('bodyLimit()', () => {
  it('rejects an oversize body with a 413 payload_too_large envelope', async () => {
    const res = await post([bodyLimit({ maxSize: 16 })], { msg: 'x'.repeat(100) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: 'payload_too_large',
      message: 'Request body exceeds the maximum allowed size',
    })
  })

  it('passes a body under the limit', async () => {
    const res = await post([bodyLimit({ maxSize: 1024 })], { msg: 'hi' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ msg: 'hi' })
  })

  it('exposes a 1 MiB default and accepts a small body with no explicit maxSize', async () => {
    expect(DEFAULT_MAX_BODY_SIZE).toBe(1024 * 1024)
    const res = await post([bodyLimit()], { msg: 'hi' })
    expect(res.status).toBe(200)
  })

  it('supports a custom onError response', async () => {
    const res = await post(
      [bodyLimit({ maxSize: 4, onError: (c) => c.json({ error: 'too_big' }, 413) })],
      { msg: 'hello world' },
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too_big' })
  })

  // Pin the inclusive boundary: the limit is "reject when size > maxSize", so a
  // body of *exactly* maxSize passes and one byte more is rejected. A `>` -> `>=`
  // off-by-one would flip the first case to 413 and fail this pair.
  const WRAPPER_BYTES = JSON.stringify({ msg: '' }).length // bytes of `{"msg":""}`
  const bodyOfBytes = (n: number) => JSON.stringify({ msg: 'x'.repeat(n - WRAPPER_BYTES) })

  it('accepts a body of exactly maxSize bytes', async () => {
    const maxSize = 64
    const body = bodyOfBytes(maxSize)
    expect(new TextEncoder().encode(body).byteLength).toBe(maxSize)
    const res = await post([bodyLimit({ maxSize })], body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(JSON.parse(body))
  })

  it('rejects a body one byte over maxSize with 413', async () => {
    const maxSize = 64
    const body = bodyOfBytes(maxSize + 1)
    expect(new TextEncoder().encode(body).byteLength).toBe(maxSize + 1)
    const res = await post([bodyLimit({ maxSize })], body)
    expect(res.status).toBe(413)
  })
})

describe('composition + opt-in defaults', () => {
  it('composes all three; security + CORS headers ride along on a success response', async () => {
    const res = await post([cors(), secureHeaders(), bodyLimit({ maxSize: 1024 })], { msg: 'hi' })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.json()).toEqual({ msg: 'hi' })
  })

  it('a route with no hardening middleware is unchanged — no headers, no size limit', async () => {
    const res = await post([], { msg: 'x'.repeat(5000) })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBeNull()
    expect(res.headers.get('x-frame-options')).toBeNull()
  })
})
