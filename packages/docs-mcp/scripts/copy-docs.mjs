#!/usr/bin/env node
// Copies the framework's docs into this package (ADR-0023) so the published
// npm tarball is self-contained — a consumer running `npx @katajs-framework/docs-mcp`
// has no checkout of the Kata monorepo to read `docs/` from. `data/` is
// generated and gitignored (see root `.gitignore`); this script is the only
// thing that writes it, and it runs before both `start` (dev) and `build`.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const sourceDocsRoot = join(repoRoot, 'docs')
const destDocsRoot = join(packageRoot, 'data', 'docs')

const SECTIONS = ['guide', 'cookbook', 'reference', 'adr']

rmSync(destDocsRoot, { recursive: true, force: true })
mkdirSync(destDocsRoot, { recursive: true })

for (const section of SECTIONS) {
  const sourceDir = join(sourceDocsRoot, section)
  if (!readdirSync(sourceDocsRoot).includes(section)) continue
  cpSync(sourceDir, join(destDocsRoot, section), {
    recursive: true,
    filter: (src) => !src.endsWith('_template.md'),
  })
}
