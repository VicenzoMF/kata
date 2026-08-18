import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateManifest, serializeManifest } from '@kata/verify'
import { describe, expect, it } from 'vitest'

/**
 * The `provides.json` katajs ships is generated from these sources by
 * `pnpm run provides-manifest` (wired into `build`). It is how `kata verify`
 * resolves `cors()` in a downstream app's chain instead of silently disabling
 * `kata/scoped-slot-not-provided` (issue #206) — so a manifest that no longer
 * matches the sources is a real defect, not a formatting nit. This test is the
 * guard: add or change a middleware without regenerating, and it fails here
 * rather than weakening every installed app's checks.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const ENTRY_POINTS = {
  '.': 'src/index.ts',
  './jwt': 'src/jwt/index.ts',
  './node': 'src/node/index.ts',
}

const readFile = (path: string): string | undefined => {
  const full = isAbsolute(path) ? path : join(packageRoot, path)
  return existsSync(full) && !full.endsWith('/') ? tryRead(full) : undefined
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined // a directory on the resolution path
  }
}

describe('provides.json', () => {
  it('matches what the middleware sources declare', () => {
    const committed = readFileSync(join(packageRoot, 'provides.json'), 'utf8')
    expect(committed).toBe(serializeManifest(generateManifest(ENTRY_POINTS, readFile)))
  })

  it('declares every first-party middleware as providing no scoped slot', () => {
    const manifest = generateManifest(ENTRY_POINTS, readFile)
    expect(Object.keys(manifest.exports['.'] ?? {})).toEqual(['bodyLimit', 'cors', 'secureHeaders'])
    for (const entry of Object.values(manifest.exports['.'] ?? {})) {
      expect(entry.provides).toEqual([])
    }
  })
})
