/**
 * Rule: `kata/scoped-slot-not-provided` (issue #8, enforces ADR-0004; amended by
 * issue #88 / ADR-0012 to count app-level providers).
 *
 * A scoped slot (`scoped<T>()` in `defineContext`) is empty until a middleware
 * `c.set`s it. So a route handler that reads `c.get('<slot>')` must have a
 * middleware whose `provides` includes `'<slot>'` run before it — either in its
 * own `use:` chain or in the app-level `createApp({ middlewares: [...] })` chain,
 * which runs before every route (ADR-0012). Otherwise the read resolves an unset
 * slot and throws at runtime (`scoped slot '<slot>' read before being set`). The
 * type system intentionally does not enforce this (see the `RouteContext.get`
 * note in kata's context.ts) — this rule does.
 *
 * Detection (cross-file): build a `middleware identifier → provides` map from
 * every `defineMiddleware({ provides, ... })` in the project, then for each
 * `defineRoute` collect the scoped keys its handler reads via `<ctx>.get('key')`
 * and check each against the union of `provides` of the middlewares in `use:`
 * plus those of the app-level `createApp({ middlewares })` chain.
 *
 * Bails (no issues for the affected read/route) to keep the false-positive rate
 * at zero when: the scoped-key set is indeterminate (no/spread `defineContext`);
 * the handler's context parameter is destructured; or a `use:` entry — or an
 * app-level `middlewares` entry — cannot be resolved to a known middleware (a
 * `cors()`-style factory call, a spread, or an identifier whose `provides` is
 * itself indeterminate) — any of which *might* supply the slot. An unresolvable
 * global entry suppresses the affected reads across every route.
 */
import ts from 'typescript'

import {
  type FunctionLike,
  firstParameterName,
  forEachDescendant,
  functionProperty,
  hasSpread,
  isCalleeNamed,
  parseSource,
  positionOf,
  propertyName,
  unwrapExpression,
} from '../parse'
import type { Issue, Rule, SourceFile } from '../types'

const NAME = 'kata/scoped-slot-not-provided'

/** A middleware's declared provides: the literal key set, or `null` when indeterminate. */
type Provides = ReadonlySet<string> | null

export const scopedSlotNotProvided: Rule = {
  name: NAME,
  check(project) {
    const scoped = project.scopedKeys
    // No scoped slots (or indeterminate registry) → nothing this rule can prove.
    if (!scoped || scoped.size === 0) return []

    const providesByName = buildProvidesMap(project.files)
    // App-level `createApp({ middlewares })` runs before every route (ADR-0012),
    // so its providers count as provided for all of them. Resolve once.
    const global = resolveGlobalProviders(project.files, providesByName)
    const issues: Issue[] = []

    for (const file of project.files) {
      if (!file.relPath.endsWith('.route.ts')) continue
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node) || !isCalleeNamed(node, 'defineRoute')) return
        const config = node.arguments[0]
        if (!config || !ts.isObjectLiteralExpression(config)) return

        const handler = functionProperty(config, 'handler')
        if (!handler) return
        const ctx = firstParameterName(handler)
        if (ctx === undefined) return // destructured ctx → can't trace reads → bail

        const reads = collectScopedReads(handler, ctx, scoped)
        if (reads.length === 0) return

        const { provided, indeterminate } = resolveUse(config, providesByName)
        const reported = new Set<string>()
        for (const { key, node: readNode } of reads) {
          if (provided.has(key) || global.provided.has(key)) continue
          // An unresolved use: or app-level middlewares entry might provide it.
          if (indeterminate || global.indeterminate) continue
          if (reported.has(key)) continue
          reported.add(key)
          const { line, column } = positionOf(sf, readNode)
          issues.push(makeIssue(file.relPath, line, column, key, scoped))
        }
      })
    }
    return issues
  },
}

/** Map every `const NAME = defineMiddleware({ provides })` in the project to its provides. */
function buildProvidesMap(files: readonly SourceFile[]): ReadonlyMap<string, Provides> {
  const map = new Map<string, Provides>()
  for (const file of files) {
    const sf = parseSource(file.path, file.text)
    forEachDescendant(sf, (node) => {
      if (!ts.isCallExpression(node) || !isCalleeNamed(node, 'defineMiddleware')) return
      const name = bindingName(node)
      if (name !== undefined) addProvides(map, name, providesOf(node))
    })
  }
  return map
}

/** The identifier a `defineMiddleware(...)` call is assigned to (`const NAME = ...`). */
function bindingName(call: ts.CallExpression): string | undefined {
  const parent = call.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  return undefined
}

/** A middleware's provides: the literal key set, or `null` when it can't be fully enumerated. */
function providesOf(call: ts.CallExpression): Provides {
  const config = call.arguments[0]
  if (!config || !ts.isObjectLiteralExpression(config) || hasSpread(config)) return null
  for (const member of config.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member) !== 'provides') continue
    const value = unwrapExpression(member.initializer)
    if (!ts.isArrayLiteralExpression(value)) return null
    const keys = new Set<string>()
    for (const element of value.elements) {
      if (!ts.isStringLiteralLike(element)) return null // spread / computed → can't enumerate
      keys.add(element.text)
    }
    return keys
  }
  return new Set() // no `provides` property → provides nothing (determinate)
}

/** Merge a middleware's provides into the map; collisions union, indeterminate wins. */
function addProvides(map: Map<string, Provides>, name: string, provides: Provides): void {
  const existing = map.get(name)
  if (existing === undefined) {
    map.set(name, provides)
  } else if (existing === null || provides === null) {
    map.set(name, null)
  } else {
    map.set(name, new Set([...existing, ...provides]))
  }
}

/** The union of provides supplied by a route's `use:` chain, and whether any entry is unresolved. */
function resolveUse(
  config: ts.ObjectLiteralExpression,
  providesByName: ReadonlyMap<string, Provides>,
): { provided: ReadonlySet<string>; indeterminate: boolean } {
  const useMember = config.properties.find(
    (m): m is ts.PropertyAssignment => ts.isPropertyAssignment(m) && propertyName(m) === 'use',
  )
  return resolveMiddlewareList(useMember?.initializer, providesByName)
}

/**
 * The union of provides supplied by the app-level middleware chain
 * (`createApp({ middlewares: [...] })`), counted as provided for *every* route:
 * the global chain runs before any route's `use:` (ADR-0012), so a slot it
 * provides is populated before any handler reads it. Scans the whole project for
 * the `createApp` call — it lives in a non-route file such as `src/main.ts` — and
 * merges every match (union of provides, OR of indeterminacy) so the result does
 * not depend on call order or count.
 *
 * The contribution is determinate-empty — routes checked exactly as before — only
 * when there is demonstrably no global chain: no `createApp` at all, or a
 * `createApp({ ... })` object literal with no spread and no `middlewares`
 * property. Every shape where a global chain *might* exist but cannot be read is
 * indeterminate, suppressing the affected reads across every route to preserve the
 * zero-false-positive contract: a non-object-literal config, an object-level
 * spread that could inject `middlewares`, a shorthand/non-array `middlewares`, or
 * an array entry that is a `cors()`-style factory call, a spread, or an
 * unresolved-provides identifier (the same conservatism `use:` applies per route).
 */
function resolveGlobalProviders(
  files: readonly SourceFile[],
  providesByName: ReadonlyMap<string, Provides>,
): { provided: ReadonlySet<string>; indeterminate: boolean } {
  const provided = new Set<string>()
  let indeterminate = false
  for (const file of files) {
    const sf = parseSource(file.path, file.text)
    forEachDescendant(sf, (node) => {
      if (!ts.isCallExpression(node) || !isCalleeNamed(node, 'createApp')) return
      const config = node.arguments[0]
      // A createApp whose config can't be fully read might still declare a global
      // chain; be indeterminate rather than miss its providers and false-positive
      // on every route that reads one.
      if (!config || !ts.isObjectLiteralExpression(config) || hasSpread(config)) {
        indeterminate = true
        return
      }
      const member = config.properties.find((m) => propertyName(m) === 'middlewares')
      if (!member) return // no `middlewares` chain on this app → contributes nothing
      if (!ts.isPropertyAssignment(member)) {
        indeterminate = true // shorthand / method `middlewares` → can't read the array
        return
      }
      const resolved = resolveMiddlewareList(member.initializer, providesByName)
      for (const key of resolved.provided) provided.add(key)
      if (resolved.indeterminate) indeterminate = true
    })
  }
  return { provided, indeterminate }
}

/**
 * Resolve a middleware-array literal — a route's `use:` or the app-level
 * `middlewares:` — to the union of provides its entries supply, plus whether any
 * entry is unresolved. Both arrays hold `Middleware` values resolved against the
 * same `defineMiddleware → provides` map, so they share this logic.
 *
 * An absent property (`value === undefined`) provides nothing, determinately. A
 * non-array initializer, a non-identifier entry (a `cors()`-style factory call or
 * a spread), or an identifier whose `provides` is itself indeterminate makes the
 * whole list indeterminate — the conservatism that keeps false positives at zero.
 */
function resolveMiddlewareList(
  value: ts.Expression | undefined,
  providesByName: ReadonlyMap<string, Provides>,
): { provided: ReadonlySet<string>; indeterminate: boolean } {
  const provided = new Set<string>()
  if (value === undefined) return { provided, indeterminate: false }

  const list = unwrapExpression(value)
  if (!ts.isArrayLiteralExpression(list)) return { provided, indeterminate: true }

  let indeterminate = false
  for (const element of list.elements) {
    if (!ts.isIdentifier(element)) {
      // A factory call (`cors()`), spread, or other expression — unknown provides.
      indeterminate = true
      continue
    }
    const provides = providesByName.get(element.text)
    if (provides === undefined || provides === null) {
      indeterminate = true
      continue
    }
    for (const key of provides) provided.add(key)
  }
  return { provided, indeterminate }
}

/** Collect `<ctx>.get('key')` reads whose key is a scoped slot. */
function collectScopedReads(
  handler: FunctionLike,
  ctx: string,
  scoped: ReadonlySet<string>,
): { key: string; node: ts.Node }[] {
  const reads: { key: string; node: ts.Node }[] = []
  forEachDescendant(handler, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'get') return
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== ctx) return

    const arg = node.arguments[0]
    if (!arg || !ts.isStringLiteralLike(arg)) return
    if (scoped.has(arg.text)) reads.push({ key: arg.text, node })
  })
  return reads
}

function makeIssue(
  file: string,
  line: number,
  column: number,
  key: string,
  scoped: ReadonlySet<string>,
): Issue {
  const slots = [...scoped].sort().join(', ')
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `route reads scoped slot c.get('${key}') but no middleware in its use: chain provides it`,
    why: `ADR-0004 (Pattern C): a scoped slot is empty until a middleware c.sets it. Reading c.get('${key}') with no providing middleware in the route's \`use:\` chain throws at runtime ("scoped slot '${key}' read before being set").`,
    fix: `Add a middleware that provides '${key}' so it runs before this read — a defineMiddleware declaring \`provides: ['${key}']\` that c.sets it — either in this route's \`use: [...]\` array or app-wide in \`createApp({ middlewares: [...] })\` (ADR-0012). Scoped slots in this project: ${slots}.`,
    example: {
      bad: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/me',",
        '  input: {},',
        '  output: UserSchema,',
        "  handler: (c) => c.get('currentUser'), // no middleware provides currentUser",
        '})',
      ].join('\n'),
      good: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/me',",
        "  use: [authMiddleware], // provides: ['currentUser']",
        '  input: {},',
        '  output: UserSchema,',
        "  handler: (c) => c.get('currentUser'),",
        '})',
      ].join('\n'),
    },
  }
}
