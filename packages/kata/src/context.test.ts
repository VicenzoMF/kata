import { describe, expect, it } from 'vitest'
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
