/**
 * Rule: `kata/middleware-provides-mismatch` (issue #9, enforces ADR-0004).
 *
 * A `defineMiddleware({ provides: [...], handler })` declares the scoped slots it
 * populates. Every key listed in `provides` must actually be written by the
 * handler via `c.set('<key>', ...)`. A declared-but-unset slot is a broken
 * contract: `kata/scoped-slot-not-provided` trusts `provides` to prove a route's
 * scoped read is satisfied, so a route using this middleware would pass lint yet
 * throw at runtime (`scoped slot '<key>' read before being set`).
 *
 * Detection: AST-match each `defineMiddleware({ ... })` call, read the literal
 * keys in `provides` (unwrapping a trailing `as const`), then scan the handler
 * for `<ctx>.set('<key>', ...)` calls — where `<ctx>` is the handler's first
 * parameter, resolved per-middleware rather than assumed to be `c`. Any provided
 * key with no matching set is flagged.
 *
 * Bails (no issues) — to keep the false-positive rate at zero — when the config
 * is spread, `provides` is not an array literal, the handler is missing or its
 * context parameter is not a plain identifier, or the handler contains a dynamic
 * `c.set(expr, ...)` whose key cannot be read statically.
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
import type { Issue, Rule } from '../types'

const NAME = 'kata/middleware-provides-mismatch'

export const middlewareProvidesMismatch: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node)) return
        if (!isCalleeNamed(node, 'defineMiddleware')) return

        const config = node.arguments[0]
        if (!config || !ts.isObjectLiteralExpression(config)) return
        if (hasSpread(config)) return

        const declared = declaredProvides(config)
        if (declared.length === 0) return

        const handler = functionProperty(config, 'handler')
        if (!handler) return // handler missing / not a function literal → can't see sets
        const ctx = firstParameterName(handler)
        if (ctx === undefined) return // destructured or missing ctx param → bail

        const sets = collectSetKeys(handler, ctx)
        if (sets.dynamic) return // a dynamic key could be any provided slot → bail

        for (const { key, node: keyNode } of declared) {
          if (sets.keys.has(key)) continue
          const { line, column } = positionOf(sf, keyNode)
          issues.push(makeIssue(file.relPath, line, column, key))
        }
      })
    }
    return issues
  },
}

/** The string-literal keys in `provides`, each with its node (for precise reporting). */
function declaredProvides(config: ts.ObjectLiteralExpression): { key: string; node: ts.Node }[] {
  for (const member of config.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member) !== 'provides') continue
    const value = unwrapExpression(member.initializer)
    if (!ts.isArrayLiteralExpression(value)) return [] // indeterminate shape → nothing provable
    const out: { key: string; node: ts.Node }[] = []
    for (const element of value.elements) {
      if (ts.isStringLiteralLike(element)) out.push({ key: element.text, node: element })
    }
    return out
  }
  return []
}

/** Collect `<ctx>.set('key', ...)` keys in the handler, flagging any dynamic (non-literal) key. */
function collectSetKeys(
  handler: FunctionLike,
  ctx: string,
): { keys: ReadonlySet<string>; dynamic: boolean } {
  const keys = new Set<string>()
  let dynamic = false
  forEachDescendant(handler, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'set') return
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== ctx) return

    const arg = node.arguments[0]
    if (!arg) return
    if (ts.isStringLiteralLike(arg)) keys.add(arg.text)
    else dynamic = true
  })
  return { keys, dynamic }
}

function makeIssue(file: string, line: number, column: number, key: string): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `middleware lists '${key}' in provides but its handler never calls c.set('${key}', ...)`,
    why: "ADR-0004 (Pattern C): a middleware's `provides` is the contract downstream routes depend on — `kata/scoped-slot-not-provided` trusts it to prove a scoped read is satisfied. If `provides` lists a slot the handler never sets, the route passes lint but throws at runtime (`scoped slot '...' read before being set`).",
    fix: `Either call \`c.set('${key}', value)\` in this middleware's handler, or drop '${key}' from its \`provides\` array.`,
    example: {
      bad: [
        'defineMiddleware({',
        "  provides: ['currentUser'] as const,",
        '  handler: async (c, next) => {',
        '    // never sets currentUser',
        '    await next()',
        '  },',
        '})',
      ].join('\n'),
      good: [
        'defineMiddleware({',
        "  provides: ['currentUser'] as const,",
        '  handler: async (c, next) => {',
        "    c.set('currentUser', await getUserFromJWT(c))",
        '    await next()',
        '  },',
        '})',
      ].join('\n'),
    },
  }
}
