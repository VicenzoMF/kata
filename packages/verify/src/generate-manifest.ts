/**
 * Generating a package's `provides.json` from its own middleware sources.
 *
 * A package ships compiled JavaScript, which `kata verify` cannot read — so
 * without a manifest every `cors()` in an app is unresolvable, and before issue
 * #206 that silently disabled `kata/scoped-slot-not-provided` project-wide. The
 * alternative fix, a hardcoded list of first-party middleware names inside the
 * verifier, rots the moment a new middleware ships or a user re-exports one.
 *
 * Generating the manifest from source at build time cannot rot: whatever the
 * package exports is what the manifest describes. `@katajs/core` runs this in its
 * `build` script (see `manifest-cli.ts`), and a test asserts the committed file
 * still matches its sources, so a drifted manifest fails CI rather than
 * silently weakening a downstream app's checks.
 *
 * Third-party middleware authors get the same mechanism: point this at your
 * entry points, ship the resulting `provides.json`, and your middleware becomes
 * resolvable in every Kata app that installs it.
 */
import ts from 'typescript'

import {
  collectSlotReads,
  isMiddlewareLiteral,
  literalProvides,
  returnedExpressions,
} from './middleware-graph'
import { functionProperty, isCalleeNamed, parseSource, providesOf, unwrapExpression } from './parse'
import type { ManifestEntry, ProvidesManifest, SourceFile } from './types'

/** Read a source file, or `undefined` when it does not exist. */
export type ReadFile = (path: string) => string | undefined

/**
 * Build the manifest for a package whose public surface is `entryPoints`
 * (export subpath → entry source file, e.g. `{'.': 'src/index.ts'}` with paths
 * as `readFile` understands them).
 *
 * The scan is the package's *public* surface only: each entry point's
 * `export … from` graph is followed, and the exported middleware values found
 * along it are recorded. Anything internal, and anything that is not a
 * middleware (a plain handler factory such as `jwtAuth`, a type), is skipped.
 */
export function generateManifest(
  entryPoints: Readonly<Record<string, string>>,
  readFile: ReadFile,
): ProvidesManifest {
  const exports: Record<string, Record<string, ManifestEntry>> = {}
  for (const subpath of Object.keys(entryPoints).sort()) {
    const entryPath = entryPoints[subpath] as string
    const found: Record<string, ManifestEntry> = {}
    for (const modulePath of moduleClosure(entryPath, readFile)) {
      const text = readFile(modulePath)
      if (text === undefined) continue
      for (const [name, entry] of exportedMiddlewares(modulePath, text)) found[name] = entry
    }
    exports[subpath] = sortKeys(found)
  }
  return { version: 1, exports }
}

/** Serialise a manifest the way it is committed: sorted, 2-space, trailing newline. */
export function serializeManifest(manifest: ProvidesManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * The entry file plus every module reachable from it through `export … from`
 * re-exports — the set of files that can contribute a public export.
 */
function moduleClosure(entryPath: string, readFile: ReadFile): string[] {
  const seen = new Set<string>()
  const queue = [entryPath]
  const out: string[] = []

  while (queue.length > 0) {
    const path = queue.shift() as string
    if (seen.has(path)) continue
    seen.add(path)
    const text = readFile(path)
    if (text === undefined) continue
    out.push(path)

    const sf = parseSource(path, text)
    for (const statement of sf.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue
      const specifier = statement.moduleSpecifier
      if (!ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) continue
      const target = resolveRelative(path, specifier.text, readFile)
      if (target) queue.push(target)
    }
  }
  return out
}

/** Resolve `./x` against `from`, trying `x.ts` then `x/index.ts`. */
function resolveRelative(from: string, specifier: string, readFile: ReadFile): string | undefined {
  const base = joinPath(
    dirName(from),
    specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier,
  )
  for (const candidate of [`${base}.ts`, base, joinPath(base, 'index.ts')]) {
    if (readFile(candidate) !== undefined) return candidate
  }
  return undefined
}

/** Every exported middleware value declared in one module, by exported name. */
function exportedMiddlewares(path: string, text: string): [string, ManifestEntry][] {
  const sf = parseSource(path, text)
  const file: SourceFile = { path, relPath: path, text }
  const out: [string, ManifestEntry][] = []

  for (const statement of sf.statements) {
    if (!isExported(statement)) continue

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const entry = middlewareEntry([declaration.initializer], file, sf)
        if (entry) out.push([declaration.name.text, entry])
      }
      continue
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      // A middleware *factory*: `export function cors(opts) { return { __kata: … } }`.
      const entry = middlewareEntry(returnedExpressions(statement), file, sf)
      if (entry) out.push([statement.name.text, entry])
    }
  }
  return out
}

/**
 * The manifest entry for a set of candidate expressions (a const's initializer,
 * or every expression a factory returns), or `undefined` when none of them is a
 * middleware — which is how non-middleware exports are skipped.
 */
function middlewareEntry(
  candidates: readonly ts.Expression[],
  file: SourceFile,
  sf: ts.SourceFile,
): ManifestEntry | undefined {
  let matched = false
  let provides: string[] | null = []
  const reads = new Set<string>()

  for (const candidate of candidates) {
    const expr = unwrapExpression(candidate)

    if (ts.isObjectLiteralExpression(expr) && isMiddlewareLiteral(expr)) {
      matched = true
      provides = mergeProvides(provides, literalProvides(expr))
      addReads(reads, functionProperty(expr, 'handler'), file, sf)
      continue
    }
    if (ts.isCallExpression(expr) && isCalleeNamed(expr, 'defineMiddleware')) {
      matched = true
      provides = mergeProvides(provides, providesOf(expr))
      const config = expr.arguments[0]
      if (config && ts.isObjectLiteralExpression(config)) {
        addReads(reads, functionProperty(config, 'handler'), file, sf)
      }
    }
  }

  if (!matched) return undefined
  const sortedReads = [...reads].sort()
  return {
    provides: provides === null ? null : [...new Set(provides)].sort(),
    ...(sortedReads.length > 0 ? { reads: sortedReads } : {}),
  }
}

function mergeProvides(
  current: string[] | null,
  next: ReadonlySet<string> | null,
): string[] | null {
  if (current === null || next === null) return null
  return [...current, ...next]
}

function addReads(
  reads: Set<string>,
  handler: ReturnType<typeof functionProperty>,
  file: SourceFile,
  sf: ts.SourceFile,
): void {
  if (!handler) return
  for (const read of collectSlotReads(handler, file, sf)) reads.add(read.key)
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(record).sort()) out[key] = record[key] as T
  return out
}

function dirName(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '.' : path.slice(0, index)
}

function joinPath(dir: string, relative: string): string {
  const segments = [...dir.split('/'), ...relative.split('/')]
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      if (out.length === 0) out.push(segment === '' ? '' : '.')
      continue
    }
    if (segment === '..') {
      if (out.length > 1) out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}
