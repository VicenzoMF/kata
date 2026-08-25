/**
 * Rule: `kata/no-raw-boundary-cast` (ADR-0025, supersedes ADR-0019).
 *
 * A raw `as never` cast is disallowed everywhere except `hono-bridge.ts` —
 * the single audited shim (`typedGet`/`typedSet`/`typedJson`) for the
 * Hono/Kata get-set-json boundary. A raw `as unknown` cast is disallowed
 * anywhere without a `// kata-allow: hono-boundary` comment documenting its
 * necessity — unchanged from ADR-0019, still the escape hatch for the
 * handful of structurally-necessary casts that aren't this boundary (DI slot
 * branding, `defineContext`'s covariant return, dynamic method dispatch).
 */
import ts from 'typescript'
import { forEachDescendant, positionOf } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/no-raw-boundary-cast'
const BRIDGE_FILE_SUFFIX = 'hono-bridge.ts'

export const noRawBoundaryCast = {
  name: NAME,
  description:
    '`as never` is contained to hono-bridge.ts; `as unknown` boundary casts elsewhere are explicitly marked',
  adr: 'ADR-0025',
  check(project) {
    const issues: Issue[] = []

    for (const file of project.files) {
      if (!file.relPath.endsWith('.ts')) continue
      const isBridgeFile = file.relPath.endsWith(BRIDGE_FILE_SUFFIX)

      const sf = project.ast(file)
      const lines = file.text.split('\n')

      forEachDescendant(sf, (node) => {
        if (!ts.isAsExpression(node)) return

        const type = node.type
        const isNever = type.kind === ts.SyntaxKind.NeverKeyword
        const isUnknown = type.kind === ts.SyntaxKind.UnknownKeyword

        if (!isNever && !isUnknown) return

        const lineAndChar = positionOf(sf, node)

        if (isNever && !isBridgeFile) {
          issues.push({
            rule: NAME,
            severity: 'error',
            file: file.relPath,
            line: lineAndChar.line,
            column: lineAndChar.column,
            message:
              'Raw `as never` cast is only allowed inside hono-bridge.ts — route it through typedGet/typedSet/typedJson',
            why: 'ADR-0025: every Hono/Kata get-set-json boundary cast is contained to one audited shim instead of being sprinkled, marker-only, across the codebase.',
            fix: "Call typedGet/typedSet/typedJson from './hono-bridge' instead of casting inline.",
            example: {
              bad: 'const store = c.get(SCOPED_STORE as never)',
              good: "import { typedGet } from './hono-bridge'\nconst store = typedGet(c, SCOPED_STORE)",
            },
          })
          return
        }

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
          why: 'ADR-0019 / ADR-0025: a structurally-necessary cast outside the hono-bridge.ts shim must still be explicitly marked to prevent uncontrolled type circumvention.',
          fix: 'Add `// kata-allow: hono-boundary` on the line preceding this cast.',
          example: {
            bad: 'const record = claims as unknown as Record<string, unknown>',
            good: '// kata-allow: hono-boundary\nconst record = claims as unknown as Record<string, unknown>',
          },
        })
      })
    }
    return issues
  },
} satisfies Rule
