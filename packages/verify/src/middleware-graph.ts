/**
 * Resolving a middleware *expression* — as written in a route's `use:` array or
 * in `createApp({ middlewares })` — to the contract it carries: the slots it
 * provides and the slots its handler reads.
 *
 * Before issue #206 this was a name lookup: only a bare `ts.Identifier` whose
 * text matched some `const <name> = defineMiddleware(...)` *anywhere* in the
 * project resolved. Two consequences, both bad:
 *
 *  - a factory call (`cors()`, the shape ADR-0012 and the docs tell users to
 *    write) resolved to nothing, and "nothing" was contagious — one unresolved
 *    app-level entry disabled `kata/scoped-slot-not-provided` project-wide;
 *  - the name map was module-blind, so two files each declaring `authenticate`
 *    had their `provides` unioned into one contract belonging to neither.
 *
 * So resolution here is *binding*-based, not name-based. An identifier is
 * followed to its declaration in its own module; an import is followed across
 * the module graph (named, aliased, namespaced, and `export … from` re-exports);
 * a call expression is followed to the factory's `return` and read off the
 * middleware literal it yields; and an import from an npm package is answered by
 * the package's `provides.json` manifest (see `manifest.ts`).
 *
 * Everything is best-effort in one direction only: when a shape cannot be
 * resolved the answer is `null` ("unknown"), never a guess. The caller turns
 * `null` into a reported {@link Suppression}, which is what makes the gap
 * visible instead of silent.
 */
import ts from 'typescript'

import {
  type FunctionLike,
  firstParameterName,
  forEachDescendant,
  functionProperty,
  hasSpread,
  isCalleeNamed,
  positionOf,
  propertyName,
  providesOf,
  unwrapExpression,
} from './parse'
import type { ManifestEntry, Project, SourceFile } from './types'

/** One `<ctx>.get('key')` read inside a middleware handler. */
export type SlotRead = {
  readonly key: string
  /** Path of the file holding the read, relative to the project root. */
  readonly file: string
  readonly line: number
  readonly column: number
  /**
   * True when the read sits after the handler's own `next()` call, so it runs
   * *after* everything downstream of this middleware. Such a read may legally
   * observe a slot a later middleware set, so it is checked against the whole
   * chain rather than against the prefix before this entry.
   */
  readonly afterNext: boolean
}

/** The middleware contract behind a chain entry. */
export type ResolvedMiddleware = {
  /** Slots its `provides` declares, or `null` when they cannot be enumerated. */
  readonly provides: ReadonlySet<string> | null
  /**
   * Scoped reads visible in its handler. Best-effort by construction: a handler
   * that is not a function literal (`handler: jwtAuth({...})`) contributes no
   * reads. That can only cost a missed ordering error, never a false positive —
   * and unlike `provides`, an unseen read cannot make a *provided* slot look
   * unprovided, which is why it does not force the entry to `null`.
   */
  readonly reads: readonly SlotRead[]
}

/**
 * Resolve a middleware expression written in `file`. `null` means "cannot be
 * proven" — an unreadable factory, an import from a package with no manifest, a
 * spread, a value built at runtime.
 */
export type MiddlewareResolver = (
  expr: ts.Expression,
  file: SourceFile,
) => ResolvedMiddleware | null

export function createMiddlewareResolver(project: Project): MiddlewareResolver {
  const byPath = new Map(project.files.map((file) => [file.path, file]))

  // ── module graph ─────────────────────────────────────────────────────────

  /** A binding an identifier resolves to, once imports have been followed. */
  type Binding =
    | { readonly kind: 'value'; readonly expr: ts.Expression; readonly file: SourceFile }
    | {
        readonly kind: 'function'
        readonly fn: FunctionLike | ts.FunctionDeclaration
        readonly file: SourceFile
      }
    | { readonly kind: 'package'; readonly entry: ManifestEntry }
    | { readonly kind: 'namespace'; readonly specifier: string; readonly file: SourceFile }

  /** The project file a module specifier resolves to, or `undefined` if it leaves the project. */
  function resolveModule(specifier: string, from: SourceFile): SourceFile | undefined {
    if (!specifier.startsWith('.')) return undefined
    const base = joinPath(dirName(from.path), specifier)
    // `./x` may be written with the ESM `.js` extension, or point at a directory.
    const withoutJs = base.endsWith('.js') ? base.slice(0, -'.js'.length) : base
    for (const candidate of [`${withoutJs}.ts`, withoutJs, joinPath(withoutJs, 'index.ts')]) {
      const file = byPath.get(candidate)
      if (file) return file
    }
    return undefined
  }

  /** The manifest entry for `name` imported from a bare specifier, or `undefined`. */
  function resolvePackageExport(specifier: string, name: string): ManifestEntry | undefined {
    const { packageName, subpath } = splitSpecifier(specifier)
    const manifest = project.packageManifest(packageName)
    return manifest?.exports[subpath]?.[name]
  }

  /**
   * Follow `name` in `file` to its binding, crossing modules as needed. `seen`
   * guards against import cycles (and a re-export that loops back).
   */
  function resolveBinding(name: string, file: SourceFile, seen: Set<string>): Binding | undefined {
    const key = `${file.path}#${name}`
    if (seen.has(key)) return undefined
    seen.add(key)

    const sf = project.ast(file)
    for (const statement of sf.statements) {
      const binding = bindingFromStatement(statement, name, file, seen)
      if (binding) return binding
    }
    return undefined
  }

  function bindingFromStatement(
    statement: ts.Statement,
    name: string,
    file: SourceFile,
    seen: Set<string>,
  ): Binding | undefined {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
        if (!declaration.initializer) return undefined
        return { kind: 'value', expr: declaration.initializer, file }
      }
      return undefined
    }

    if (ts.isFunctionDeclaration(statement)) {
      return statement.name?.text === name ? { kind: 'function', fn: statement, file } : undefined
    }

    if (ts.isImportDeclaration(statement)) {
      return bindingFromImport(statement, name, file, seen)
    }

    if (ts.isExportDeclaration(statement)) {
      return bindingFromExport(statement, name, file, seen)
    }

    return undefined
  }

  function bindingFromImport(
    node: ts.ImportDeclaration,
    name: string,
    file: SourceFile,
    seen: Set<string>,
  ): Binding | undefined {
    const clause = node.importClause
    const specifier = moduleSpecifierOf(node.moduleSpecifier)
    if (!clause || specifier === undefined) return undefined
    const bindings = clause.namedBindings

    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
      return { kind: 'namespace', specifier, file }
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.name.text !== name) continue
        // `import { cors as c }` — follow the *exported* name, not the alias.
        const exported = element.propertyName?.text ?? element.name.text
        return followImport(specifier, exported, file, seen)
      }
    }
    return undefined
  }

  function bindingFromExport(
    node: ts.ExportDeclaration,
    name: string,
    file: SourceFile,
    seen: Set<string>,
  ): Binding | undefined {
    const specifier = node.moduleSpecifier && moduleSpecifierOf(node.moduleSpecifier)
    if (specifier === undefined) return undefined

    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        if (element.name.text !== name) continue
        return followImport(specifier, element.propertyName?.text ?? name, file, seen)
      }
      return undefined
    }
    // `export * from './x'` — the name may live there.
    return node.exportClause ? undefined : followImport(specifier, name, file, seen)
  }

  /** Continue resolution of `exported` in the module `specifier` points at. */
  function followImport(
    specifier: string,
    exported: string,
    from: SourceFile,
    seen: Set<string>,
  ): Binding | undefined {
    const target = resolveModule(specifier, from)
    if (target) return resolveBinding(exported, target, seen)
    const entry = resolvePackageExport(specifier, exported)
    return entry ? { kind: 'package', entry } : undefined
  }

  // ── middleware shapes ────────────────────────────────────────────────────

  /** Resolve any expression to a middleware contract. The recursive core. */
  function resolveValue(
    expression: ts.Expression,
    file: SourceFile,
    seen: Set<string>,
  ): ResolvedMiddleware | null {
    const expr = unwrapExpression(expression)

    if (ts.isIdentifier(expr)) {
      return fromBinding(resolveBinding(expr.text, file, seen), seen)
    }

    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      // `mw.auth` where `mw` is `import * as mw from './middlewares'`.
      const namespace = resolveBinding(expr.expression.text, file, seen)
      if (namespace?.kind !== 'namespace') return null
      return fromBinding(followImport(namespace.specifier, expr.name.text, file, seen), seen)
    }

    if (ts.isCallExpression(expr)) {
      if (isCalleeNamed(expr, 'defineMiddleware')) return fromDefineMiddleware(expr, file)
      return fromFactoryCall(expr, file, seen)
    }

    if (ts.isObjectLiteralExpression(expr)) return fromObjectLiteral(expr, file)

    return null
  }

  function fromBinding(binding: Binding | undefined, seen: Set<string>): ResolvedMiddleware | null {
    if (!binding) return null
    if (binding.kind === 'value') return resolveValue(binding.expr, binding.file, seen)
    if (binding.kind === 'package') return fromManifestEntry(binding.entry)
    // A bare function or namespace is not a middleware value.
    return null
  }

  /** `cors()` / `makeAuth(opts)` — resolve the callee, then read what it returns. */
  function fromFactoryCall(
    call: ts.CallExpression,
    file: SourceFile,
    seen: Set<string>,
  ): ResolvedMiddleware | null {
    const callee = unwrapExpression(call.expression)

    let binding: Binding | undefined
    if (ts.isIdentifier(callee)) {
      binding = resolveBinding(callee.text, file, seen)
    } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const namespace = resolveBinding(callee.expression.text, file, seen)
      if (namespace?.kind !== 'namespace') return null
      binding = followImport(namespace.specifier, callee.name.text, file, seen)
    }
    if (!binding) return null

    if (binding.kind === 'package') return fromManifestEntry(binding.entry)
    if (binding.kind === 'function') return fromFactoryBody(binding.fn, binding.file, seen)
    if (binding.kind === 'value') {
      const value = unwrapExpression(binding.expr)
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        return fromFactoryBody(value, binding.file, seen)
      }
    }
    return null
  }

  /**
   * The middleware a factory returns. Every `return` in its body (excluding
   * those belonging to nested functions — a `handler` closure has its own) must
   * resolve; the results merge, so a factory branching between two middlewares
   * yields the union of what they provide.
   */
  function fromFactoryBody(
    fn: FunctionLike | ts.FunctionDeclaration,
    file: SourceFile,
    seen: Set<string>,
  ): ResolvedMiddleware | null {
    const returned = returnedExpressions(fn)
    if (returned.length === 0) return null

    let provides: Set<string> | null = new Set()
    const reads: SlotRead[] = []
    for (const expr of returned) {
      const resolved = resolveValue(expr, file, seen)
      if (!resolved) return null
      if (resolved.provides === null) provides = null
      else if (provides !== null) for (const key of resolved.provides) provides.add(key)
      reads.push(...resolved.reads)
    }
    return { provides, reads }
  }

  function fromDefineMiddleware(call: ts.CallExpression, file: SourceFile): ResolvedMiddleware {
    const config = call.arguments[0]
    const handler =
      config && ts.isObjectLiteralExpression(config)
        ? functionProperty(config, 'handler')
        : undefined
    return { provides: providesOf(call), reads: handler ? collectReads(handler, file) : [] }
  }

  /**
   * A middleware written as a literal — `{ __kata: 'middleware', provides, handler }`,
   * which is what kata's own factories return. The `__kata` tag is required: a
   * bare object literal is not assumed to be a middleware.
   */
  function fromObjectLiteral(
    object: ts.ObjectLiteralExpression,
    file: SourceFile,
  ): ResolvedMiddleware | null {
    if (!isMiddlewareLiteral(object)) return null
    if (hasSpread(object)) return { provides: null, reads: [] }
    const handler = functionProperty(object, 'handler')
    return {
      provides: literalProvides(object),
      reads: handler ? collectReads(handler, file) : [],
    }
  }

  function fromManifestEntry(entry: ManifestEntry): ResolvedMiddleware {
    return {
      provides: entry.provides === null ? null : new Set(entry.provides),
      // A manifest names the slots but not their source positions; they are
      // reported against the chain entry instead.
      reads: (entry.reads ?? []).map((key) => ({
        key,
        file: '',
        line: 0,
        column: 0,
        afterNext: false,
      })),
    }
  }

  /** {@link collectSlotReads} against this project's cached AST for the file. */
  function collectReads(handler: FunctionLike, file: SourceFile): SlotRead[] {
    return collectSlotReads(handler, file, project.ast(file))
  }

  return (expr, file) => resolveValue(expr, file, new Set())
}

/**
 * Collect `<ctx>.get('key')` reads in a handler, marking those that run after
 * its own `next()`. Shared with the rule, which runs it over route handlers —
 * those take no `next`, so every read is a pre-`next` read.
 *
 * Returns nothing when the context parameter is destructured: the reads are then
 * untraceable, which the caller reports as a suppression rather than guessing.
 */
export function collectSlotReads(
  handler: FunctionLike,
  file: SourceFile,
  sf: ts.SourceFile,
): SlotRead[] {
  const ctx = firstParameterName(handler)
  if (ctx === undefined) return []

  const nextStart = firstNextCallPosition(handler)
  const reads: SlotRead[] = []
  forEachDescendant(handler, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'get') return
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== ctx) return
    const arg = node.arguments[0]
    if (!arg || !ts.isStringLiteralLike(arg)) return

    const start = node.getStart(sf)
    const { line, column } = positionOf(sf, node)
    reads.push({
      key: arg.text,
      file: file.relPath,
      line,
      column,
      afterNext: nextStart !== undefined && start > nextStart,
    })
  })
  return reads
}

/** Start offset of the handler's first `next()` call, or `undefined` if it never calls it. */
function firstNextCallPosition(handler: FunctionLike): number | undefined {
  const next = handler.parameters[1]
  if (!next || !ts.isIdentifier(next.name)) return undefined
  const name = next.name.text
  let earliest: number | undefined
  forEachDescendant(handler, (node) => {
    if (!ts.isCallExpression(node)) return
    if (!ts.isIdentifier(node.expression) || node.expression.text !== name) return
    const start = node.getStart()
    if (earliest === undefined || start < earliest) earliest = start
  })
  return earliest
}

/** True when the literal carries kata's `__kata: 'middleware'` tag. */
export function isMiddlewareLiteral(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some((member) => {
    if (!ts.isPropertyAssignment(member) || propertyName(member) !== '__kata') return false
    const value = unwrapExpression(member.initializer)
    return ts.isStringLiteralLike(value) && value.text === 'middleware'
  })
}

/** The `provides` of a middleware object literal, or `null` when it cannot be enumerated. */
export function literalProvides(object: ts.ObjectLiteralExpression): ReadonlySet<string> | null {
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member) !== 'provides') continue
    const value = unwrapExpression(member.initializer)
    if (!ts.isArrayLiteralExpression(value)) return null
    const keys = new Set<string>()
    for (const element of value.elements) {
      if (!ts.isStringLiteralLike(element)) return null
      keys.add(element.text)
    }
    return keys
  }
  return new Set() // no `provides` property → provides nothing
}

/**
 * Expressions the function returns, ignoring `return`s inside nested functions
 * (a middleware's own `handler` closure returns a `Response`, not a middleware).
 * An arrow with an expression body returns it directly.
 */
export function returnedExpressions(fn: FunctionLike | ts.FunctionDeclaration): ts.Expression[] {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body]
  const body = fn.body
  if (!body || !ts.isBlock(body)) return []

  const out: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return // a nested function's returns are its own
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression)
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(body, walk)
  return out
}

/** The literal text of a module specifier, or `undefined` when it is dynamic. */
function moduleSpecifierOf(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined
}

/**
 * Split a bare specifier into the installed package and the export subpath
 * a manifest is keyed by: `katajs/jwt` → `katajs` + `./jwt`, `@scope/pkg` →
 * `@scope/pkg` + `.`.
 */
function splitSpecifier(specifier: string): { packageName: string; subpath: string } {
  const parts = specifier.split('/')
  const take = specifier.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, take).join('/')
  const rest = parts.slice(take)
  return { packageName, subpath: rest.length === 0 ? '.' : `./${rest.join('/')}` }
}

// Path helpers. `@kata/verify` treats file paths as opaque POSIX-ish strings
// (they come from `fs-walk`, and tests use `/repo/...` literals), so joining and
// normalising `..` here keeps module resolution free of `node:path` — and free of
// the Windows-separator mismatch importing it would introduce.

function dirName(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function joinPath(dir: string, relative: string): string {
  const segments = [...dir.split('/'), ...relative.split('/')]
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      if (out.length === 0) out.push('') // keep a leading `/`
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
