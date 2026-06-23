/**
 * Rule: `kata/no-class` (issue #165, enforces ADR-0002).
 *
 * Kata's public API is strictly functional — no `class XController extends Y`,
 * no metadata reflection, no runtime IoC container. Classes hide control flow
 * behind inheritance and lifecycle methods, which is hard to grep and hard for
 * an agent to verify mechanically. This rule rejects `class` declarations and
 * `class` expressions in Kata-owned `src/**`.
 *
 * Escape hatch (ADR-0002 "Negative"): a third-party-required class (e.g. a
 * TypeORM entity) is allowed when the offending `class` is preceded by an inline
 * `// kata-allow: class-required-by-vendor` leading comment that references the
 * ADR's documented exception.
 *
 * Scope: only Kata-owned `src/**` sources. Declaration files (`*.d.ts`) carry
 * vendored class *types*, not Kata code, and the file walker already excludes
 * them; the rule also guards defensively against both.
 */
import ts from 'typescript'

import { forEachDescendant, parseSource, positionOf } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/no-class'

/** The inline comment that opts a single `class` out of the ban (ADR-0002). */
const ESCAPE_HATCH = 'kata-allow: class-required-by-vendor'

/** Files this rule governs: Kata-owned `src/**`, excluding vendored declarations. */
function isGuardedFile(relPath: string): boolean {
  return relPath.startsWith('src/') && !relPath.endsWith('.d.ts')
}

export const noClass: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      if (!isGuardedFile(file.relPath)) continue
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) return
        if (hasEscapeHatch(sf, node)) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column, classNameOf(node)))
      })
    }
    return issues
  },
}

/**
 * True when the `// kata-allow: class-required-by-vendor` comment sits in the
 * leading trivia of the `class` node or of its enclosing statement. Checking the
 * enclosing statement covers `const Foo = class {}`, where the natural place for
 * the comment is the line above the `const`, not between `=` and `class`.
 */
function hasEscapeHatch(sf: ts.SourceFile, node: ts.Node): boolean {
  const text = sf.text
  for (const target of [node, enclosingStatement(node)]) {
    if (target === undefined) continue
    const ranges = ts.getLeadingCommentRanges(text, target.getFullStart()) ?? []
    for (const range of ranges) {
      if (text.slice(range.pos, range.end).includes(ESCAPE_HATCH)) return true
    }
  }
  return false
}

/** The nearest ancestor statement of `node`, or `undefined` if there is none. */
function enclosingStatement(node: ts.Node): ts.Node | undefined {
  let current = node.parent
  while (current) {
    if (ts.isStatement(current)) return current
    current = current.parent
  }
  return undefined
}

/** The class's name for the message (`class Foo`), or the anonymous placeholder. */
function classNameOf(node: ts.ClassDeclaration | ts.ClassExpression): string {
  return node.name?.text ?? '(anonymous)'
}

function makeIssue(file: string, line: number, column: number, name: string): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `\`class ${name}\` declared in ${file} — Kata's API is strictly functional, classes are banned in src/`,
    why: "ADR-0002: Kata's public API is strictly functional (defineRoute, defineMiddleware, defineContext, createApp + plain objects). Classes hide control flow behind inheritance, lifecycle methods, and runtime IoC — mechanically un-greppable and hard for an agent to verify. The ban applies to Kata-owned code, not to vendored types.",
    fix: 'Replace the class with a factory function returning a plain object, or a module of named functions. If a third-party library *requires* a class (e.g. a TypeORM entity), prefix the declaration with `// kata-allow: class-required-by-vendor` to opt this one declaration out (ADR-0002 escape hatch).',
    example: {
      bad: ['class UserService {', '  findAll() {', '    return []', '  }', '}'].join('\n'),
      good: [
        'export function createUserService() {',
        '  return {',
        '    findAll: () => [],',
        '  }',
        '}',
      ].join('\n'),
    },
  }
}
