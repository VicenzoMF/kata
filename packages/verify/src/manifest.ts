/**
 * Loading the `provides.json` a middleware-shipping package publishes.
 *
 * `kata verify` reads source, and an installed package is compiled JavaScript —
 * so a middleware imported from `katajs` used to be unresolvable, which
 * (before issue #206) silently disabled `kata/scoped-slot-not-provided` for the
 * whole project. A manifest closes that hole without a hardcoded allowlist in
 * the verifier: `katajs` generates one at build time from its own middleware
 * sources, so it cannot drift when a new first-party middleware ships, and any
 * third-party author gets the same mechanism by shipping the same file.
 *
 * This is the one impure corner of the pipeline. `buildProject` calls
 * {@link createManifestLoader} and hands the result to the rules as
 * `project.packageManifest`, so rules keep taking everything they need as data.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse as parsePath } from 'node:path'

import type { ManifestEntry, ProvidesManifest } from './types'

/** Resolve a package's manifest, or `null` when it ships none. Memoized per loader. */
export type ManifestLoader = (packageName: string) => ProvidesManifest | null

/**
 * A loader that looks for `<pkg>/provides.json` in the `node_modules` chain
 * above `root`, mirroring Node's own resolution (and following the symlinks a
 * pnpm workspace installs, which is how the examples reach `packages/kata`).
 */
export function createManifestLoader(root: string): ManifestLoader {
  const cache = new Map<string, ProvidesManifest | null>()
  return (packageName) => {
    const hit = cache.get(packageName)
    if (hit !== undefined) return hit
    const manifest = loadManifest(root, packageName)
    cache.set(packageName, manifest)
    return manifest
  }
}

function loadManifest(root: string, packageName: string): ProvidesManifest | null {
  for (const dir of ancestors(root)) {
    const candidate = join(dir, 'node_modules', packageName, 'provides.json')
    if (!existsSync(candidate)) continue
    return parseManifest(readFileSync(candidate, 'utf8'))
  }
  return null
}

/** `dir`, its parent, its grandparent, … up to the filesystem root. */
function ancestors(dir: string): string[] {
  const out: string[] = []
  let current = dir
  const { root } = parsePath(dir)
  while (true) {
    out.push(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/**
 * Parse and structurally validate a manifest. A malformed or unknown-version
 * file resolves to `null` — the package is simply treated as unresolvable
 * (which surfaces as a reported suppression, never as a false positive).
 */
export function parseManifest(text: string): ProvidesManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw['version'] !== 1 || !isRecord(raw['exports'])) return null

  const exports: Record<string, Record<string, ManifestEntry>> = {}
  for (const [subpath, entries] of Object.entries(raw['exports'])) {
    if (!isRecord(entries)) return null
    const parsed: Record<string, ManifestEntry> = {}
    for (const [name, entry] of Object.entries(entries)) {
      const value = parseEntry(entry)
      if (value === null) return null
      parsed[name] = value
    }
    exports[subpath] = parsed
  }
  return { version: 1, exports }
}

function parseEntry(entry: unknown): ManifestEntry | null {
  if (!isRecord(entry)) return null
  const provides = entry['provides']
  if (provides !== null && !isStringArray(provides)) return null
  const reads = entry['reads']
  if (reads !== undefined && !isStringArray(reads)) return null
  return { provides, ...(reads === undefined ? {} : { reads }) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
