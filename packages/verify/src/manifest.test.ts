import { describe, expect, it } from 'vitest'

import { createManifestLoader, parseManifest } from './manifest'

describe('parseManifest()', () => {
  it('parses a well-formed manifest', () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        exports: { '.': { cors: { provides: [] }, session: { provides: ['currentUser'] } } },
      }),
    )
    expect(manifest?.exports['.']?.['cors']?.provides).toEqual([])
    expect(manifest?.exports['.']?.['session']?.provides).toEqual(['currentUser'])
  })

  it('keeps an explicit null provides (the package declares it cannot enumerate them)', () => {
    const manifest = parseManifest('{"version":1,"exports":{".":{"x":{"provides":null}}}}')
    expect(manifest?.exports['.']?.['x']?.provides).toBeNull()
  })

  it('reads the optional reads array', () => {
    const manifest = parseManifest(
      '{"version":1,"exports":{"./jwt":{"g":{"provides":[],"reads":["currentUser"]}}}}',
    )
    expect(manifest?.exports['./jwt']?.['g']?.reads).toEqual(['currentUser'])
  })

  // Every rejection below leaves the package unresolvable, which surfaces as a
  // reported suppression — never as a false positive.
  it.each([
    ['invalid JSON', '{ not json'],
    ['an unknown version', '{"version":2,"exports":{}}'],
    ['a missing exports map', '{"version":1}'],
    ['a non-object entry', '{"version":1,"exports":{".":{"x":"nope"}}}'],
    ['a non-string provides element', '{"version":1,"exports":{".":{"x":{"provides":[1]}}}}'],
    ['a non-array reads', '{"version":1,"exports":{".":{"x":{"provides":[],"reads":"a"}}}}'],
  ])('rejects %s', (_label, text) => {
    expect(parseManifest(text)).toBeNull()
  })
})

describe('createManifestLoader()', () => {
  it('finds the manifest katajs ships, walking up to the workspace node_modules', () => {
    // The examples install `katajs` as a workspace link, so this exercises the
    // real lookup path an installed app takes.
    const load = createManifestLoader(new URL('../../../examples/hello', import.meta.url).pathname)
    const manifest = load('katajs')
    expect(manifest?.exports['.']?.['cors']?.provides).toEqual([])
  })

  it('returns null for a package that ships none', () => {
    const load = createManifestLoader(new URL('../../../examples/hello', import.meta.url).pathname)
    expect(load('hono')).toBeNull()
  })

  it('memoizes, so a package is looked up once per loader', () => {
    const load = createManifestLoader(new URL('../../../examples/hello', import.meta.url).pathname)
    expect(load('katajs')).toBe(load('katajs'))
  })
})
