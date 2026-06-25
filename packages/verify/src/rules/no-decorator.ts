/**
 * Rule: `kata/no-decorator` (companion to ADR-0002).
 *
 * Decorator syntax (`@Injectable()`, `@Controller()`, `@Get()`, parameter
 * decorators, …) is rejected anywhere under `src/`. ADR-0002 keeps Kata's public
 * API strictly functional: decorators encode hidden control flow (metadata at
 * decoration time, runtime IoC) that is hard to grep and impossible for the
 * harness to verify mechanically. A route is `defineRoute({...})` and nothing
 * else.
 *
 * Detection: walk the AST and match every `ts.Decorator` node — covering class,
 * method, accessor, property, and parameter decorators alike. The reported
 * position is the `@` itself.
 *
 * Escape hatch (same shape as `kata/no-class`): a decorator is allowed when its
 * decorated declaration is preceded by an inline `// kata-allow: <reason>`
 * comment that references this ADR or a third-party requirement (e.g.
 * `// kata-allow: decorator-required-by-vendor`). Third-party classes that
 * *require* decorators (TypeORM entities, …) are the documented case.
 */
import ts from 'typescript'

import { forEachDescendant, parseSource, positionOf } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/no-decorator'

/** The inline escape-hatch marker (ADR-0002). Matches `// kata-allow: <reason>`. */
const ALLOW_MARKER = /kata-allow:/

/** Only `src/` is Kata-owned code; the ban does not reach config, scripts, etc. */
function isGuardedFile(relPath: string): boolean {
  return relPath === 'src' || relPath.startsWith('src/')
}

export const noDecorator: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      if (!isGuardedFile(file.relPath)) continue
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isDecorator(node)) return
        // The decorated declaration (class/method/param/…) carries the leading
        // trivia where the allow-comment lives, since decorators come first.
        const owner = node.parent
        if (owner && hasAllowComment(sf, owner)) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column))
      })
    }
    return issues
  },
}

/**
 * True when `node`'s leading trivia contains a `// kata-allow:` comment. The
 * comment must precede the decorated declaration (and thus its first decorator),
 * matching ADR-0002's "preceded by an inline allow-comment" wording.
 */
function hasAllowComment(sf: ts.SourceFile, node: ts.Node): boolean {
  const text = sf.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  return ranges.some((range) => ALLOW_MARKER.test(text.slice(range.pos, range.end)))
}

function makeIssue(file: string, line: number, column: number): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: 'Decorator syntax (@…) is not allowed in src/ — Kata is strictly functional',
    why: "ADR-0002: Kata's public API is strictly functional — no classes, no decorators. Decorators encode hidden control flow (metadata at decoration time, runtime IoC, reflect-metadata cold-start cost) that is hard to grep and impossible for the harness to verify mechanically. A route is `defineRoute({...})` and nothing else.",
    fix: 'Replace the decorated declaration with the functional equivalent: `defineRoute`/`defineMiddleware`/`defineContext` + plain objects (NestJS guards/interceptors/pipes become functions). If a third-party library genuinely requires the decorator, precede the declaration with `// kata-allow: decorator-required-by-vendor`.',
    example: {
      bad: [
        '// users.controller.ts',
        "@Controller('users')",
        'export class UsersController {',
        "  @Get(':id')",
        "  findOne(@Param('id') id: string) {",
        '    return this.service.findOne(id)',
        '  }',
        '}',
      ].join('\n'),
      good: [
        '// users.route.ts',
        'export const getUser = defineRoute({',
        "  method: 'GET',",
        "  path: '/users/:id',",
        '  input: { params: GetUserParamsSchema },',
        '  output: UserSchema,',
        '  handler: async (c) => findUser(c.input.params.id),',
        '})',
      ].join('\n'),
    },
  }
}
