/**
 * Extract context-registry information from a project's `src/context.ts`. The
 * full key set feeds `kata/context-key-not-registered`; the scoped subset feeds
 * `kata/scoped-slot-not-provided` (both ADR-0004).
 */
import ts from 'typescript'

import { forEachDescendant, hasSpread, isCalleeNamed, parseSource, propertyName } from './parse'

/**
 * Every key declared by `defineContext({ ... })`, or `null` when it cannot be
 * determined with certainty — no `defineContext` call, or a spread inside it
 * that could inject unknown keys. Returning `null` disables the dependent rule,
 * keeping the false-positive rate at zero.
 */
export function extractRegistryKeys(contextSource: string): ReadonlySet<string> | null {
  return collectContextKeys(contextSource, () => true)
}

/**
 * The subset of registry keys declared as request-scoped slots (`scoped<T>()`),
 * with the same `null`-when-indeterminate semantics as {@link extractRegistryKeys}.
 * This is the set `kata/scoped-slot-not-provided` treats as "must be populated by
 * a middleware" (ADR-0004); singletons are always available and excluded.
 */
export function extractScopedKeys(contextSource: string): ReadonlySet<string> | null {
  return collectContextKeys(contextSource, isScopedSlot)
}

/**
 * Locate the `defineContext({ ... })` call and collect the names of members
 * matching `include`. Returns `null` (indeterminate) when there is no
 * `defineContext` call or a spread could inject unknown keys.
 */
function collectContextKeys(
  contextSource: string,
  include: (member: ts.ObjectLiteralElementLike) => boolean,
): ReadonlySet<string> | null {
  const sf = parseSource('context.ts', contextSource)
  let keys: ReadonlySet<string> | null = null

  forEachDescendant(sf, (node) => {
    if (keys !== null) return
    if (!ts.isCallExpression(node) || !isCalleeNamed(node, 'defineContext')) return

    const arg = node.arguments[0]
    if (!arg || !ts.isObjectLiteralExpression(arg)) return
    // A spread could inject arbitrary keys — we can no longer prove a key is
    // unregistered (or that the scoped subset is complete), so leave it indeterminate.
    if (hasSpread(arg)) return

    const found = new Set<string>()
    for (const member of arg.properties) {
      const name = propertyName(member)
      if (name && include(member)) found.add(name)
    }
    keys = found
  })

  return keys
}

/** A `key: scoped<T>()` registry member, as opposed to `key: singleton(...)`. */
function isScopedSlot(member: ts.ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(member)) return false
  const init = member.initializer
  return ts.isCallExpression(init) && isCalleeNamed(init, 'scoped')
}
