/**
 * Extract the set of context keys declared by `defineContext({ ... })` in a
 * project's `src/context.ts`. This is the registry the
 * `kata/context-key-not-registered` rule checks `c.get('key')` reads against
 * (ADR-0004).
 */
import ts from 'typescript'

import { forEachDescendant, hasSpread, parseSource, propertyName } from './parse'

/**
 * Returns the registered key set, or `null` when it cannot be determined with
 * certainty — no `defineContext` call, or a spread inside it that could inject
 * unknown keys. Returning `null` disables the dependent rule, keeping the
 * false-positive rate at zero.
 */
export function extractRegistryKeys(contextSource: string): ReadonlySet<string> | null {
  const sf = parseSource('context.ts', contextSource)
  let keys: ReadonlySet<string> | null = null

  forEachDescendant(sf, (node) => {
    if (keys !== null) return
    if (!ts.isCallExpression(node)) return
    if (!isDefineContext(node)) return

    const arg = node.arguments[0]
    if (!arg || !ts.isObjectLiteralExpression(arg)) return
    // A spread could inject arbitrary keys — we can no longer prove a key is
    // unregistered, so leave the registry indeterminate.
    if (hasSpread(arg)) return

    const found = new Set<string>()
    for (const member of arg.properties) {
      const name = propertyName(member)
      if (name) found.add(name)
    }
    keys = found
  })

  return keys
}

function isDefineContext(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text === 'defineContext'
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'defineContext'
  return false
}
