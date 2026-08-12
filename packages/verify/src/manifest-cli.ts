#!/usr/bin/env tsx
/**
 * Executable wrapper around {@link generateManifest}: writes a package's
 * `provides.json` from its own sources. Run it in the package's `build` script,
 * before the bundler, so the manifest and the shipped code always describe the
 * same middlewares:
 *
 *   kata-provides-manifest --entry .=src/index.ts --entry ./jwt=src/jwt/index.ts
 *
 * Flags:
 *   --root <dir>              package root (default: cwd)
 *   --entry <subpath>=<file>  an export subpath and its entry source file
 *   --out <file>              output path (default: <root>/provides.json)
 *   --check                   do not write; exit 1 if the file is out of date
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { generateManifest, serializeManifest } from './generate-manifest'

const argv = process.argv.slice(2)

const root = resolve(process.cwd(), flag('--root') ?? '.')
const out = resolve(root, flag('--out') ?? 'provides.json')
const check = argv.includes('--check')

const entryPoints: Record<string, string> = {}
for (const value of flags('--entry')) {
  const separator = value.indexOf('=')
  if (separator === -1) {
    process.stderr.write(
      `kata-provides-manifest: --entry expects <subpath>=<file>, got "${value}"\n`,
    )
    process.exit(2)
  }
  entryPoints[value.slice(0, separator)] = value.slice(separator + 1)
}

if (Object.keys(entryPoints).length === 0) {
  process.stderr.write(
    'kata-provides-manifest: at least one --entry <subpath>=<file> is required\n',
  )
  process.exit(2)
}

const readFile = (path: string): string | undefined => {
  const full = isAbsolute(path) ? path : join(root, path)
  // `statSync`, not `existsSync`: a specifier like `./middlewares` resolves to a
  // directory, which must read as "not a file" rather than throw EISDIR.
  return statSync(full, { throwIfNoEntry: false })?.isFile() === true
    ? readFileSync(full, 'utf8')
    : undefined
}

const generated = serializeManifest(generateManifest(entryPoints, readFile))

if (check) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (current === generated) process.exit(0)
  process.stderr.write(`kata-provides-manifest: ${out} is out of date — re-run without --check\n`)
  process.exit(1)
}

writeFileSync(out, generated)

/** The value of the last `--name <value>` in argv, or `undefined`. */
function flag(name: string): string | undefined {
  const values = flags(name)
  return values[values.length - 1]
}

/** Every value passed as `--name <value>`. */
function flags(name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue
    const value = argv[i + 1]
    if (value !== undefined) values.push(value)
  }
  return values
}
