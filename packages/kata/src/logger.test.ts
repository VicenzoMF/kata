import { describe, expect, it, vi } from 'vitest'

import { scoped, singleton } from './context'
import { type Logger, logRequest, resolveLogger } from './logger'
import type { Registry } from './types'

describe('resolveLogger()', () => {
  it('returns the value of a logger singleton that implements info', () => {
    const logger: Logger = { info: () => {} }
    const registry = { logger: singleton(logger) } satisfies Registry
    expect(resolveLogger(registry)).toBe(logger)
  })

  it('returns undefined when there is no logger key', () => {
    const registry = { db: singleton({ query: () => {} }) } satisfies Registry
    expect(resolveLogger(registry)).toBeUndefined()
  })

  it('returns undefined when the logger slot is scoped, not a singleton', () => {
    const registry = { logger: scoped<Logger>() } satisfies Registry
    expect(resolveLogger(registry)).toBeUndefined()
  })

  it('returns undefined when the logger value does not implement info', () => {
    expect(
      resolveLogger({ logger: singleton({ warn: () => {} }) } satisfies Registry),
    ).toBeUndefined()
    expect(resolveLogger({ logger: singleton(42) } satisfies Registry)).toBeUndefined()
    expect(resolveLogger({ logger: singleton(null) } satisfies Registry)).toBeUndefined()
  })
})

describe('logRequest()', () => {
  const fields = { requestId: 'rid', method: 'GET', path: '/x', status: 200, durationMs: 3 }

  it('formats a single line and forwards structured fields as extra', () => {
    const info = vi.fn()
    logRequest({ info }, fields)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith('GET /x 200 3ms', {
      requestId: 'rid',
      method: 'GET',
      path: '/x',
      status: 200,
      durationMs: 3,
    })
  })

  it('uses warn for a 4xx when the logger implements it', () => {
    const info = vi.fn()
    const warn = vi.fn()
    logRequest({ info, warn }, { ...fields, status: 404 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
  })

  it('uses error for a 5xx when the logger implements it', () => {
    const info = vi.fn()
    const error = vi.fn()
    logRequest({ info, error }, { ...fields, status: 500 })
    expect(error).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
  })

  it('falls back to info when the richer level is not implemented', () => {
    const info = vi.fn()
    logRequest({ info }, { ...fields, status: 500 })
    logRequest({ info }, { ...fields, status: 404 })
    expect(info).toHaveBeenCalledTimes(2)
  })
})
