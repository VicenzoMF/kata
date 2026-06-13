/**
 * Rule: `kata/no-route-without-input-schema` (issue #7, enforces ADR-0003).
 *
 * Every `defineRoute({ ... })` call in a `*.route.ts` file must declare an
 * `input` field. The field describes which of `{ params, query, body, headers }`
 * the route reads; a route that reads none still declares `input: {}`. Making
 * the field mandatory (even when empty) keeps "did the author consider input
 * validation here?" out of the agent's decision space (ADR-0003).
 *
 * Detection: scan every `*.route.ts` file under `src/modules/`, AST-match
 * `defineRoute({ ... })`, and flag the call when the `input` key is absent. An
 * empty object literal (`input: {}`) satisfies the rule — only a *missing* key
 * is a violation. Calls whose argument is not an object literal, or that spread
 * another object, are skipped — their `input` cannot be statically proven
 * absent, so flagging them would be a false positive.
 */
import ts from 'typescript'

import {
  forEachDescendant,
  hasProperty,
  hasSpread,
  isCalleeNamed,
  parseSource,
  positionOf,
} from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/no-route-without-input-schema'

export const noRouteWithoutInputSchema: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      if (!file.relPath.endsWith('.route.ts')) continue
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node)) return
        if (!isCalleeNamed(node, 'defineRoute')) return

        const config = node.arguments[0]
        if (!config || !ts.isObjectLiteralExpression(config)) return
        if (hasSpread(config)) return
        if (hasProperty(config, 'input')) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column))
      })
    }
    return issues
  },
}

function makeIssue(file: string, line: number, column: number): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: "defineRoute is missing the required 'input' field",
    why: 'Every route must declare an `input` field (even an empty `input: {}`). Kata validates inputs against it before the handler runs (422 on mismatch), and `hc<typeof app>` infers the request shape from it. Making the field mandatory removes the "should I add input validation here?" judgment call. See ADR-0003.',
    fix: "Add an `input:` field to this defineRoute call. Use `input: {}` if the route reads no params/query/body/headers, otherwise list the Zod schemas it reads (e.g. `input: { body: CreateUserBodySchema }`) from the domain's `<domain>.schema.ts` (ADR-0005).",
    example: {
      bad: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/health',",
        '  output: HealthSchema,',
        '  handler: () => ({ ok: true }),',
        '})',
      ].join('\n'),
      good: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/health',",
        '  input: {},',
        '  output: HealthSchema,',
        '  handler: () => ({ ok: true }),',
        '})',
      ].join('\n'),
    },
  }
}
