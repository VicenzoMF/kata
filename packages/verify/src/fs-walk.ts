/**
 * Filesystem discovery: collect the `.ts` source files a project exposes to the
 * rules. Intentionally dependency-free (no glob library) — a small recursive
 * walk over `node:fs` keeps `@kata/verify` lean.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { SourceFile } from './types'

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'data',
  '.git',
])

/** Recursively collect analysable source files under `dir`. */
export function collectSourceFiles(dir: string, root: string): SourceFile[] {
  const files: SourceFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      files.push(...collectSourceFiles(full, root))
    } else if (entry.isFile() && isAnalysable(entry.name)) {
      files.push({ path: full, relPath: relative(root, full), text: readFileSync(full, 'utf8') })
    }
  }
  return files
}

/**
 * Source files the rules care about: `.ts`, excluding tests, DTO schema files
 * (no routes or `c.get` reads live there), and declaration files.
 */
function isAnalysable(name: string): boolean {
  if (!name.endsWith('.ts')) return false
  if (name.endsWith('.d.ts')) return false
  if (name.endsWith('.test.ts')) return false
  if (name.endsWith('.schema.ts')) return false
  return true
}
