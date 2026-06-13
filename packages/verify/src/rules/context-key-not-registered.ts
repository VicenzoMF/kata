/**
 * Rule: `kata/context-key-not-registered` (issue #5, enforces ADR-0004).
 *
 * `c.get('key')` must reference a key declared in `defineContext({ ... })`
 * (`src/context.ts`). An unregistered key throws at runtime; catching it at
 * lint time turns a request-time crash into an editor squiggle.
 *
 * Scope: matches `c.get('<string literal>')` where the receiver is the
 * conventional context identifier `c` (used throughout the ADRs and examples)
 * and the single argument is a string literal. Anything else — a non-`c`
 * receiver, a dynamic key, a different arity — is left alone, which keeps the
 * false-positive rate at zero. The rule disables itself entirely when the
 * registry is indeterminate (see {@link Project.registryKeys}).
 */
import ts from 'typescript'

import { forEachDescendant, parseSource, positionOf } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/context-key-not-registered'

/** The conventional context parameter name (ADR-0004 examples all use `c`). */
const CONTEXT_PARAM = 'c'

export const contextKeyNotRegistered: Rule = {
  name: NAME,
  check(project) {
    const registry = project.registryKeys
    if (registry === null) return []

    const issues: Issue[] = []
    for (const file of project.files) {
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node)) return
        const key = contextGetKey(node)
        if (key === undefined || registry.has(key)) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column, key, registry))
      })
    }
    return issues
  },
}

/** The literal key of a `c.get('key')` call, or `undefined` if it isn't one. */
function contextGetKey(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== 'get') return undefined
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== CONTEXT_PARAM)
    return undefined
  if (call.arguments.length !== 1) return undefined

  const arg = call.arguments[0]
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined
  return arg.text
}

function makeIssue(
  file: string,
  line: number,
  column: number,
  key: string,
  registry: ReadonlySet<string>,
): Issue {
  const known = [...registry].sort().join(', ')
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `c.get('${key}') reads a key that is not registered in defineContext`,
    why: '`c.get` only resolves keys declared in `defineContext({ ... })` (src/context.ts). Reading an unregistered key throws at runtime. See ADR-0004.',
    fix: `Register '${key}' in defineContext (as \`singleton(...)\` or \`scoped<T>()\`), or fix the typo. Registered keys: ${known || '(none)'}.`,
    example: {
      bad: `const user = c.get('${key}') // not a key in defineContext({ ... })`,
      good: "const user = c.get('currentUser') // matches a key in defineContext({ ... })",
    },
  }
}
