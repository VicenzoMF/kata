/**
 * Rule: `kata/scoped-read-outside-request` (issue #169, enforces ADR-0004).
 *
 * A scoped slot (`scoped<T>()` in `defineContext`) only ever holds a value
 * *during a request* — a middleware `c.set`s it on the way in. Reading one
 * outside a request handler therefore reads a slot that was never populated:
 * at module load there is no request at all, so `c.get('<scopedKey>')` resolves
 * an empty slot and throws (`scoped slot '<key>' read before being set`). The
 * canonical offender is a top-level `const u = c.get('currentUser')` or a
 * free-standing helper that reads the slot; ADR-0004 calls this a build-time
 * error, which is what this rule turns it into.
 *
 * This is the *real* rule ADR-0004 lists — distinct from
 * `kata/scoped-slot-not-provided`, which covers reads that *are* inside a route
 * handler but whose providing middleware never runs. The two never overlap: this
 * one fires only when the read is outside every handler.
 *
 * Detection: find each `c.get('<key>')` whose key is a scoped slot, then walk its
 * ancestors. If any enclosing function is the `handler` of a `defineRoute` /
 * `defineMiddleware` call, the read happens during a request — fine. Otherwise
 * (no enclosing function at all → module load; or the enclosing function is a
 * plain helper that escapes the route's `use:`-chain trace) it is flagged.
 *
 * Checking *any* enclosing handler, not merely the nearest, is deliberate: a read
 * nested in a callback the handler itself runs (`items.map(() => c.get('user'))`)
 * still executes during the request, so it must not be flagged — that keeps the
 * false-positive rate at zero.
 *
 * Bails when the scoped-key set is indeterminate or empty (nothing to prove), and
 * matches only the conventional context identifier `c` (as `kata/context-key-not-
 * registered` does) so a `map.get('x')` whose key coincides with a slot name is
 * never mistaken for a scoped read.
 */
import ts from 'typescript'

import { forEachDescendant, isCalleeNamed, parseSource, positionOf, propertyName } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/scoped-read-outside-request'

/** The conventional context parameter name (ADR-0004 examples all use `c`). */
const CONTEXT_PARAM = 'c'

export const scopedReadOutsideRequest: Rule = {
  name: NAME,
  check(project) {
    const scoped = project.scopedKeys
    // No scoped slots (or an indeterminate registry) → nothing this rule can prove.
    if (!scoped || scoped.size === 0) return []

    const issues: Issue[] = []
    for (const file of project.files) {
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node)) return
        const key = contextGetKey(node)
        if (key === undefined || !scoped.has(key)) return
        if (isInsideRequestHandler(node)) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column, key, scoped))
      })
    }
    return issues
  },
}

/** The literal key of a `c.get('key')` call (receiver `c`, single string arg), or `undefined`. */
function contextGetKey(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== 'get') return undefined
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== CONTEXT_PARAM) {
    return undefined
  }
  if (call.arguments.length !== 1) return undefined
  const arg = call.arguments[0]
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined
  return arg.text
}

/** True when `node` sits — at any depth — inside a `defineRoute`/`defineMiddleware` handler. */
function isInsideRequestHandler(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isRequestHandlerFunction(current)) return true
    current = current.parent
  }
  return false
}

/**
 * True when `node` is the `handler` function of a `defineRoute` /
 * `defineMiddleware` call — either an arrow/function assigned to a `handler:`
 * property, or a `handler(c) {}` method shorthand.
 */
function isRequestHandlerFunction(node: ts.Node): boolean {
  if (ts.isMethodDeclaration(node) && propertyName(node) === 'handler') {
    return isDefineRouteOrMiddlewareConfig(node.parent)
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent
    if (parent && ts.isPropertyAssignment(parent) && propertyName(parent) === 'handler') {
      return isDefineRouteOrMiddlewareConfig(parent.parent)
    }
  }
  return false
}

/** True when `node` is the config object literal of a `defineRoute`/`defineMiddleware` call. */
function isDefineRouteOrMiddlewareConfig(node: ts.Node | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false
  const call = node.parent
  if (!call || !ts.isCallExpression(call)) return false
  return isCalleeNamed(call, 'defineRoute') || isCalleeNamed(call, 'defineMiddleware')
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
    message: `c.get('${key}') reads a request-scoped slot outside a request handler`,
    why: `ADR-0004 (Pattern C): a scoped slot is empty until a middleware c.sets it *during a request*. Reading c.get('${key}') outside a defineRoute/defineMiddleware handler — at module load, or in a helper the request trace can't follow — resolves an unset slot and throws ("scoped slot '${key}' read before being set"). Scoped reads must sit directly in a handler so a single grep proves which route uses which slot.`,
    fix: `Move this read into the route or middleware handler that needs '${key}' (its providing middleware runs first), and pass the resolved value into any helper rather than handing the helper the context to read the slot itself. Scoped slots in this project: ${slots}.`,
    example: {
      bad: [
        "const currentUser = c.get('currentUser') // module load — no request, slot is empty",
        '',
        'export const meRoute = defineRoute({',
        "  method: 'GET',",
        "  path: '/me',",
        '  use: [requireUser],',
        '  input: {},',
        '  output: UserSchema,',
        '  handler: async () => currentUser, // throws at runtime',
        '})',
      ].join('\n'),
      good: [
        'export const meRoute = defineRoute({',
        "  method: 'GET',",
        "  path: '/me',",
        '  use: [requireUser],',
        '  input: {},',
        '  output: UserSchema,',
        "  handler: async (c) => c.get('currentUser'), // read during the request",
        '})',
      ].join('\n'),
    },
  }
}
