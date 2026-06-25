/**
 * Rule: `kata/no-raw-boundary-cast` (ADR-0016).
 *
 * Disallows raw `as never` and `as unknown` casts, requiring a
 * `// kata-allow: hono-boundary` comment to document their necessity.
 */
import ts from 'typescript'
import { forEachDescendant, parseSource, positionOf } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/no-raw-boundary-cast'

export const noRawBoundaryCast: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []

    for (const file of project.files) {
      if (!file.relPath.endsWith('.ts')) continue

      const sf = parseSource(file.path, file.text)
      const lines = file.text.split('\n')

      forEachDescendant(sf, (node) => {
        if (!ts.isAsExpression(node)) return

        const type = node.type
        const isNever = type.kind === ts.SyntaxKind.NeverKeyword
        const isUnknown = type.kind === ts.SyntaxKind.UnknownKeyword

        if (!isNever && !isUnknown) return

        const lineAndChar = positionOf(sf, node)
        // Check current line and up to 2 previous lines for the comment
        const currentLineIdx = lineAndChar.line - 1

        let hasAllowMarker = false
        for (let i = currentLineIdx; i >= Math.max(0, currentLineIdx - 2); i--) {
          const line = lines[i]
          if (line && line.includes('kata-allow: hono-boundary')) {
            hasAllowMarker = true
            break
          }
        }

        if (hasAllowMarker) return

        issues.push({
          rule: NAME,
          severity: 'error',
          file: file.relPath,
          line: lineAndChar.line,
          column: lineAndChar.column,
          message: `Raw \`as ${isNever ? 'never' : 'unknown'}\` cast is not allowed without a \`// kata-allow: hono-boundary\` marker`,
          why: 'ADR-0016: Hono boundary casts must be explicitly marked to prevent uncontrolled type circumvention.',
          fix: 'Add `// kata-allow: hono-boundary` on the line preceding this cast.',
          example: {
            bad: 'const store = c.get(SCOPED_STORE as never)',
            good: '// kata-allow: hono-boundary\nconst store = c.get(SCOPED_STORE as never)',
          },
        })
      })
    }
    return issues
  },
}
