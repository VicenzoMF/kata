import { describe, expect, it } from 'vitest'

import { generateManifest, serializeManifest } from './generate-manifest'

/** A `readFile` over an in-memory file map, as the CLI's fs-backed one behaves. */
function reader(files: Record<string, string>) {
  return (path: string): string | undefined => files[path]
}

describe('generateManifest()', () => {
  it('records a middleware factory reachable through a barrel', () => {
    const files = {
      'src/index.ts': "export { cors } from './middlewares'",
      'src/middlewares/index.ts': "export { cors } from './cors'",
      'src/middlewares/cors.ts': `export function cors(options) {
        return { __kata: 'middleware', provides: [], handler: fromHono(honoCors(options)) }
      }`,
    }
    const manifest = generateManifest({ '.': 'src/index.ts' }, reader(files))
    expect(manifest).toEqual({ version: 1, exports: { '.': { cors: { provides: [] } } } })
  })

  it('records the slots a middleware provides and reads', () => {
    const files = {
      'src/index.ts': "export { session } from './session'",
      'src/session.ts': `export const session = {
        __kata: 'middleware',
        provides: ['currentUser'],
        handler: async (c, next) => { c.set('currentUser', c.get('tenantId')); await next() },
      }`,
    }
    const manifest = generateManifest({ '.': 'src/index.ts' }, reader(files))
    expect(manifest.exports['.']?.['session']).toEqual({
      provides: ['currentUser'],
      reads: ['tenantId'],
    })
  })

  it('skips exports that are not middlewares', () => {
    const files = {
      'src/index.ts': `export function jwtAuth(options) {
        return async (c, next) => { await next() }
      }
      export const VERSION = '1.0.0'`,
    }
    expect(generateManifest({ '.': 'src/index.ts' }, reader(files)).exports['.']).toEqual({})
  })

  it('keys entries by export subpath', () => {
    const files = {
      'src/index.ts': '',
      'src/jwt/index.ts': `export const bearer = { __kata: 'middleware', provides: ['currentUser'], handler: h }`,
    }
    const manifest = generateManifest(
      { '.': 'src/index.ts', './jwt': 'src/jwt/index.ts' },
      reader(files),
    )
    expect(manifest.exports['.']).toEqual({})
    expect(manifest.exports['./jwt']?.['bearer']?.provides).toEqual(['currentUser'])
  })

  it('reports an unenumerable provides as null rather than guessing', () => {
    const files = {
      'src/index.ts': `export const dynamic = { __kata: 'middleware', provides: SLOTS, handler: h }`,
    }
    expect(
      generateManifest({ '.': 'src/index.ts' }, reader(files)).exports['.']?.['dynamic'],
    ).toEqual({ provides: null })
  })

  it('ignores a module the entry point does not re-export', () => {
    const files = {
      'src/index.ts': "export { a } from './a'",
      'src/a.ts': `export const a = { __kata: 'middleware', provides: [], handler: h }`,
      'src/internal.ts': `export const internal = { __kata: 'middleware', provides: ['x'], handler: h }`,
    }
    expect(
      Object.keys(generateManifest({ '.': 'src/index.ts' }, reader(files)).exports['.'] ?? {}),
    ).toEqual(['a'])
  })

  it('serialises deterministically, sorted and newline-terminated', () => {
    const files = {
      'src/index.ts': `export const b = { __kata: 'middleware', provides: [], handler: h }
export const a = { __kata: 'middleware', provides: [], handler: h }`,
    }
    const text = serializeManifest(generateManifest({ '.': 'src/index.ts' }, reader(files)))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'))
  })
})
