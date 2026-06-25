/**
 * Rule: `kata/no-adhoc-error-shape` (issue #167, enforces ADR-0008).
 *
 * Every 4xx/5xx error response must be built through the unified envelope helper
 * `c.error(code, message, { status })`, never hand-rolled as an inline
 * `c.json({ error: ... }, <4xx|5xx>)` literal. An ad-hoc shape escapes the one
 * declared `ErrorBody` contract: it can omit `message`, invent a sibling field,
 * and drift away from every other error the API emits — exactly the
 * unspecified-contract liability ADR-0008 removes for the error path the way
 * ADR-0003 removed it for the success path.
 *
 * Detection: AST-match a call `c.json(obj, status)` where the receiver is the
 * conventional context identifier `c`, `obj` is an object literal that
 * statically declares an `error` property, and `status` is a numeric literal in
 * the 400–599 range. Anything else — a non-`c` receiver, a spread that could
 * inject `error`, a dynamic/non-literal status, a success body, or a 2xx/3xx
 * status — is left alone, keeping the false-positive rate at zero. Success
 * responses (`c.json(body, 200)`) and the sanctioned helper (`c.error(...)`)
 * never match.
 */
import ts from 'typescript'

import {
  forEachDescendant,
  hasProperty,
  hasSpread,
  parseSource,
  positionOf,
  unwrapExpression,
} from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/no-adhoc-error-shape'

/** The conventional context parameter name (ADR examples all use `c`). */
const CONTEXT_PARAM = 'c'

const MIN_ERROR_STATUS = 400
const MAX_ERROR_STATUS = 599

export const noAdhocErrorShape: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node)) return
        const status = adhocErrorStatus(node)
        if (status === undefined) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column, status))
      })
    }
    return issues
  },
}

/**
 * The HTTP status of a `c.json({ error: ... }, <4xx|5xx>)` call, or `undefined`
 * if `call` is not an ad-hoc error response. Requires the `c` receiver, an
 * object-literal first argument that statically declares `error` (and is not
 * spread — a spread could inject or remove `error`, so we bail), and a numeric
 * status literal in 400–599.
 */
function adhocErrorStatus(call: ts.CallExpression): number | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (callee.name.text !== 'json') return undefined
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== CONTEXT_PARAM) {
    return undefined
  }
  if (call.arguments.length !== 2) return undefined

  const body = unwrapExpression(call.arguments[0] as ts.Expression)
  if (!ts.isObjectLiteralExpression(body)) return undefined
  if (hasSpread(body) || !hasProperty(body, 'error')) return undefined

  const statusArg = unwrapExpression(call.arguments[1] as ts.Expression)
  if (!ts.isNumericLiteral(statusArg)) return undefined
  const status = Number(statusArg.text)
  if (!Number.isInteger(status) || status < MIN_ERROR_STATUS || status > MAX_ERROR_STATUS) {
    return undefined
  }
  return status
}

function makeIssue(file: string, line: number, column: number, status: number): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `Ad-hoc error response c.json({ error: ... }, ${status}) — build error envelopes via c.error(...)`,
    why: 'ADR-0008: every 4xx/5xx must use the one `ErrorBody` envelope, built through the sanctioned `c.error(code, message, { status })` helper. Inline `c.json({ error: ... })` literals bypass it — they can omit the required `message`, invent sibling fields, and drift away from every other error the API emits, leaving RPC clients and the verifier with no single shape to switch on.',
    fix: `Replace this with \`c.error(code, message, { status: ${status} })\` — pass the machine-readable code (the current \`error\` value), a human-readable \`message\`, and the status in \`extra\`.`,
    example: {
      bad: "return c.json({ error: 'not_found' }, 404)",
      good: "return c.error('not_found', 'User not found', { status: 404 })",
    },
  }
}
