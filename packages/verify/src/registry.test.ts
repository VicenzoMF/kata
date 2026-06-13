import { describe, expect, it } from 'vitest'

import { extractRegistryKeys, extractScopedKeys } from './registry'

describe('extractRegistryKeys()', () => {
  it('extracts the keys of a defineContext call', () => {
    const keys = extractRegistryKeys(`
      export const k = defineContext({
        logger: singleton(logger),
        currentUser: scoped<User>(),
      })
    `)
    expect(keys).not.toBeNull()
    expect([...(keys ?? [])].sort()).toEqual(['currentUser', 'logger'])
  })

  it('supports the namespaced k.defineContext(...) call style', () => {
    const keys = extractRegistryKeys('export const k = lib.defineContext({ db: singleton(d) })')
    expect([...(keys ?? [])]).toEqual(['db'])
  })

  it('returns null when there is no defineContext call', () => {
    expect(extractRegistryKeys('export const x = 1')).toBeNull()
  })

  it('returns null (indeterminate) when the registry is spread', () => {
    const keys = extractRegistryKeys(
      'export const k = defineContext({ ...base, db: singleton(d) })',
    )
    expect(keys).toBeNull()
  })
})

describe('extractScopedKeys()', () => {
  it('returns only the scoped<T>() slots, excluding singletons', () => {
    const keys = extractScopedKeys(`
      export const k = defineContext({
        logger: singleton(logger),
        currentUser: scoped<User>(),
        tenantId: scoped<string>(),
      })
    `)
    expect(keys).not.toBeNull()
    expect([...(keys ?? [])].sort()).toEqual(['currentUser', 'tenantId'])
  })

  it('returns an empty set when there are no scoped slots', () => {
    const keys = extractScopedKeys('export const k = defineContext({ db: singleton(d) })')
    expect(keys).not.toBeNull()
    expect([...(keys ?? [])]).toEqual([])
  })

  it('returns null when there is no defineContext call', () => {
    expect(extractScopedKeys('export const x = 1')).toBeNull()
  })

  it('returns null (indeterminate) when the registry is spread', () => {
    expect(
      extractScopedKeys('export const k = defineContext({ ...base, user: scoped<User>() })'),
    ).toBeNull()
  })
})
