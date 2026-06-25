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
 * parameter, resolved per-middleware rather than assumed to be `c`. Two passes:
 *   • forward — any *declared* key with no matching set is a broken contract,
 *     flagged as an **error** (a route trusting it throws at runtime);
 *   • reverse — any *set* literal key absent from `provides` is over-providing,
 *     flagged as a **warning** (an extra populated slot is benign and another
 *     middleware may legitimately declare it, so this never fails the build).
 *
 * Bails (no issues) — to keep the false-positive rate at zero — when the config
 * is spread, `provides` is not an array literal, the handler is missing or its
 * context parameter is not a plain identifier, or the handler contains a dynamic
 * `c.set(expr, ...)` whose key cannot be read statically.
 */
import ts from 'typescript'

import {
  declaredProvides,
  type FunctionLike,
  firstParameterName,
  forEachDescendant,
  functionProperty,
  hasSpread,
  isCalleeNamed,
  parseSource,
  positionOf,
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

        const declaredKeys = new Set(declared.map(({ key }) => key))

        // Forward pass: every declared key must be set (a broken contract → error).
        for (const { key, node: keyNode } of declared) {
          if (sets.keys.has(key)) continue
          const { line, column } = positionOf(sf, keyNode)
          issues.push(makeIssue(file.relPath, line, column, key))
        }

        // Reverse pass: a key the handler sets but never declares in `provides`.
        // Benign (an extra populated slot harms nothing, and another middleware
        // may legitimately declare it), so emit a warning, not an error.
        for (const [key, setNode] of sets.keys) {
          if (declaredKeys.has(key)) continue
          const { line, column } = positionOf(sf, setNode)
          issues.push(makeOverProvidesIssue(file.relPath, line, column, key))
        }
      })
    }
    return issues
  },
}

/**
 * Collect `<ctx>.set('key', ...)` calls in the handler, mapping each literal key
 * to the node of its (first) set for precise reporting, and flagging any dynamic
 * (non-literal) key.
 */
function collectSetKeys(
  handler: FunctionLike,
  ctx: string,
): { keys: ReadonlyMap<string, ts.Node>; dynamic: boolean } {
  const keys = new Map<string, ts.Node>()
  let dynamic = false
  forEachDescendant(handler, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'set') return
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== ctx) return

    const arg = node.arguments[0]
    if (!arg) return
    if (ts.isStringLiteralLike(arg)) {
      if (!keys.has(arg.text)) keys.set(arg.text, arg)
    } else dynamic = true
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

/**
 * The complement of {@link makeIssue}: the handler sets a slot the middleware
 * never lists in `provides`. Surfaced as a **warning** — an extra populated slot
 * is benign, and another middleware may legitimately declare it — so it nudges
 * the contract back into alignment without failing the build on a false positive.
 */
function makeOverProvidesIssue(file: string, line: number, column: number, key: string): Issue {
  return {
    rule: NAME,
    severity: 'warning',
    file,
    line,
    column,
    message: `middleware handler calls c.set('${key}', ...) but '${key}' is not listed in its provides`,
    why: "ADR-0004 (Pattern C): a middleware's `provides` is the contract downstream routes depend on — `kata/scoped-slot-not-provided` trusts it to prove a scoped read is satisfied. A slot the handler sets but omits from `provides` is invisible to that proof, so a route relying on it is flagged as unprovided even though it is populated at runtime. (Benign — another middleware may declare the slot — hence a warning.)",
    fix: `Add '${key}' to this middleware's \`provides\` array so the slot it populates is part of its declared contract, or drop the \`c.set('${key}', ...)\` if the slot is unintended.`,
    example: {
      bad: [
        'defineMiddleware({',
        "  provides: ['currentUser'] as const,",
        '  handler: async (c, next) => {',
        "    c.set('currentUser', await getUserFromJWT(c))",
        "    c.set('tenantId', c.get('currentUser').tenantId) // sets tenantId, never declared",
        '    await next()',
        '  },',
        '})',
      ].join('\n'),
      good: [
        'defineMiddleware({',
        "  provides: ['currentUser', 'tenantId'] as const,",
        '  handler: async (c, next) => {',
        "    c.set('currentUser', await getUserFromJWT(c))",
        "    c.set('tenantId', c.get('currentUser').tenantId)",
        '    await next()',
        '  },',
        '})',
      ].join('\n'),
    },
  }
}
