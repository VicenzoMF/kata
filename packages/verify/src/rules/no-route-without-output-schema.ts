/**
 * Rule: `kata/no-route-without-output-schema` (issue #4, enforces ADR-0003).
 *
 * Every `defineRoute({ ... })` call in a `*.route.ts` file must declare an
 * `output` Zod schema. Without it, RPC clients can't infer return types and
 * responses bypass runtime validation.
 *
 * Detection: scan every `*.route.ts` file under `src/modules/`, AST-match
 * `defineRoute({ ... })`, and flag the call when the `output` key is absent.
 * Calls whose argument is not an
 * object literal, or that spread another object, are skipped — their `output`
 * cannot be statically proven absent, so flagging them would be a false
 * positive.
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

const NAME = 'kata/no-route-without-output-schema'

export const noRouteWithoutOutputSchema: Rule = {
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
        if (hasProperty(config, 'output')) return

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
    message: "defineRoute is missing the required 'output' schema",
    why: 'Every route must declare an `output` Zod schema: responses are validated at runtime (500 on mismatch) and `hc<typeof app>` infers return types from it. Optional output schemas degrade the RPC contract. See ADR-0003.',
    fix: "Add an `output:` field to this defineRoute call, pointing at a Zod schema from the domain's `<domain>.schema.ts` (ADR-0005).",
    example: {
      bad: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/users/:id',",
        '  input: { params: z.object({ id: z.string() }) },',
        '  handler: async (c) => getUser(c.input.params.id),',
        '})',
      ].join('\n'),
      good: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/users/:id',",
        '  input: { params: z.object({ id: z.string() }) },',
        '  output: UserSchema,',
        '  handler: async (c) => getUser(c.input.params.id),',
        '})',
      ].join('\n'),
    },
  }
}
