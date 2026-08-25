import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { typedGet, typedJson, typedSet } from './hono-bridge'

async function captureContext(): Promise<import('hono').Context> {
  const app = new Hono()
  let captured: import('hono').Context | undefined
  app.get('/x', (c) => {
    captured = c
    return c.text('ok')
  })
  await app.fetch(new Request('http://localhost/x'))
  if (!captured) throw new Error('handler did not run')
  return captured
}

describe('typedGet / typedSet', () => {
  it('round-trips a string-keyed value through a real Hono Context', async () => {
    const c = await captureContext()
    typedSet(c, 'greeting', 'hello')
    expect(typedGet<string>(c, 'greeting')).toBe('hello')
  })

  it('round-trips a symbol-keyed value, distinct from a same-named string key', async () => {
    const c = await captureContext()
    const sym = Symbol('bridge-test')
    typedSet(c, sym, { tagged: true })
    typedSet(c, 'bridge-test', { tagged: false })
    expect(typedGet<{ tagged: boolean }>(c, sym)).toEqual({ tagged: true })
    expect(typedGet<{ tagged: boolean }>(c, 'bridge-test')).toEqual({ tagged: false })
  })

  it('returns undefined for a key nothing set', async () => {
    const c = await captureContext()
    expect(typedGet<unknown>(c, 'never-set')).toBeUndefined()
  })

  it('also works against a plain object exposing get/set (Kata’s own context shape)', () => {
    const store = new Map<string, unknown>()
    const target = {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value)
      },
    }
    typedSet(target, 'k', 42)
    expect(typedGet<number>(target, 'k')).toBe(42)
  })
})

describe('typedJson', () => {
  it('builds a 200 JSON response by default', async () => {
    const c = await captureContext()
    const res = typedJson(c, { ok: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('honours an explicit status', async () => {
    const c = await captureContext()
    const res = typedJson(c, { created: true }, 201)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ created: true })
  })
})
