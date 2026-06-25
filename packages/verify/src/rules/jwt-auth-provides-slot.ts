/**
 * Rule: `kata/jwt-auth-provides-slot` (issue #168, enforces ADR-0013).
 *
 * `jwtAuth({ slot, ... })` authenticates a request and writes the validated
 * claims into a scoped slot (default `'currentUser'`). It returns just the
 * *handler*, so the caller owns the `defineMiddleware({ provides: [slot], ... })`
 * wrapper — keeping the `provides` literal at the call site where lint can read it
 * (ADR-0013 Alternative C). This rule asserts that contract: when a middleware's
 * `handler` is a `jwtAuth(...)` call, its `provides` array must list the slot
 * `jwtAuth` fills, or a downstream route's scoped read passes lint yet throws at
 * runtime (`scoped slot '<slot>' read before being set`).
 *
 * This is the `jwtAuth`-specific analogue of `kata/middleware-provides-mismatch`:
 * that rule keys on literal `<ctx>.set('<key>', ...)` calls, which it cannot see
 * through the `jwtAuth` indirection (`jwtAuth` does the `c.set` internally). The
 * slot is read from the options object's `slot` string literal here instead.
 *
 * Detection: AST-match each `defineMiddleware({ ... })` whose `handler` is a
 * `jwtAuth(...)` call, read the call's `slot` option (default `'currentUser'`),
 * then assert the middleware's `provides` array literal contains it.
 *
 * Bails (no issues) — to keep the false-positive rate at zero — when the config or
 * the `jwtAuth` options object is spread, the `handler` is not a `jwtAuth(...)`
 * call, the options is not an object literal, `slot` is present but not a string
 * literal (a dynamic slot can't be proved), or `provides` is present but not an
 * array literal.
 */
import ts from 'typescript'

import {
  forEachDescendant,
  hasSpread,
  isCalleeNamed,
  parseSource,
  positionOf,
  propertyName,
  providesOf,
  unwrapExpression,
} from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/jwt-auth-provides-slot'

/** Slot `jwtAuth` fills when its `slot` option is omitted (mirrors `DEFAULT_SLOT`). */
const DEFAULT_SLOT = 'currentUser'

export const jwtAuthProvidesSlot: Rule = {
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

        const handler = propertyValue(config, 'handler')
        if (!handler || !ts.isCallExpression(handler) || !isCalleeNamed(handler, 'jwtAuth')) return

        const slot = jwtAuthSlot(handler)
        if (slot === undefined) return // dynamic / unreadable slot → can't prove

        const provided = providesOf(node)
        if (provided === null) return // indeterminate `provides` shape → bail
        if (provided.has(slot)) return

        const { line, column } = positionOf(sf, handler)
        issues.push(makeIssue(file.relPath, line, column, slot))
      })
    }
    return issues
  },
}

/**
 * The slot a `jwtAuth(...)` call fills: its `slot` string-literal option, or the
 * default `'currentUser'` when omitted. `undefined` (bail) when the options is not
 * an object literal, is spread, or carries a non-literal `slot` we cannot read.
 */
function jwtAuthSlot(call: ts.CallExpression): string | undefined {
  const options = call.arguments[0]
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined
  if (hasSpread(options)) return undefined

  for (const member of options.properties) {
    if (!ts.isPropertyAssignment(member) || propertyName(member) !== 'slot') continue
    const value = unwrapExpression(member.initializer)
    return ts.isStringLiteralLike(value) ? value.text : undefined
  }
  return DEFAULT_SLOT
}

/** The unwrapped value expression of object-literal property `name`, or `undefined`. */
function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const member of object.properties) {
    if (ts.isPropertyAssignment(member) && propertyName(member) === name) {
      return unwrapExpression(member.initializer)
    }
  }
  return undefined
}

function makeIssue(file: string, line: number, column: number, slot: string): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `middleware handler is jwtAuth({ slot: '${slot}' }) but its provides array does not include '${slot}'`,
    why: "ADR-0013 (Alternative C): `jwtAuth` returns only the handler and does its `c.set('<slot>', ...)` internally, so the caller's `defineMiddleware({ provides: [...] })` is the only place the slot contract is declared. `kata/middleware-provides-mismatch` keys on literal `c.set` calls it cannot see through the `jwtAuth` indirection, so if `provides` omits the slot a downstream route's scoped read passes lint yet throws at runtime (`scoped slot '<slot>' read before being set`).",
    fix: `Add '${slot}' to this middleware's \`provides\` array — \`provides: ['${slot}'] as const\` — matching the slot \`jwtAuth\` fills (its \`slot\` option, default '${DEFAULT_SLOT}').`,
    example: {
      bad: [
        'defineMiddleware({',
        `  handler: jwtAuth({ secret, claims, slot: '${slot}' }),`,
        '})',
      ].join('\n'),
      good: [
        'defineMiddleware({',
        `  provides: ['${slot}'] as const,`,
        `  handler: jwtAuth({ secret, claims, slot: '${slot}' }),`,
        '})',
      ].join('\n'),
    },
  }
}
