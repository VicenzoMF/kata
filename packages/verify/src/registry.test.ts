import { describe, expect, it } from 'vitest'

import { extractRegistryKeys } from './registry'

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
