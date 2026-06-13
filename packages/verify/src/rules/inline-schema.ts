/**
 * Rule: `kata/inline-schema` (issue #6, enforces ADR-0005).
 *
 * Zod schema construction (`z.object(...)`, `z.string()`, any `z.<method>(...)`)
 * may only appear in `*.schema.ts` files. Building a schema inline in a
 * `*.route.ts` or `*.service.ts` file blocks reuse by name, invites duplication,
 * and turns "find every use of this shape" into a fuzzy grep instead of an exact
 * symbol search (ADR-0005).
 *
 * Detection: scan every `*.route.ts` / `*.service.ts` file, AST-match the
 * *root* of each Zod chain — a call `z.<method>(...)` whose receiver is the
 * conventional `z` import. Only the outermost root is reported: `z.object({ id:
 * z.string() })` is a single inline schema, so it yields one issue, not three.
 * Method chains (`z.string().email()`) likewise report once, at the chain root.
 *
 * `*.schema.ts` files never reach this rule — the file walker excludes them
 * (they are the one place inline schemas are allowed).
 */
import ts from 'typescript'

import { forEachDescendant, parseSource, positionOf } from '../parse'
import type { Issue, Rule } from '../types'

const NAME = 'kata/inline-schema'

/** The conventional Zod import identifier (`import { z } from 'zod'`). */
const ZOD_NAMESPACE = 'z'

/** Files where inline schema construction is a violation (ADR-0005). */
function isGuardedFile(relPath: string): boolean {
  return relPath.endsWith('.route.ts') || relPath.endsWith('.service.ts')
}

export const inlineSchema: Rule = {
  name: NAME,
  check(project) {
    const issues: Issue[] = []
    for (const file of project.files) {
      if (!isGuardedFile(file.relPath)) continue
      const sf = parseSource(file.path, file.text)
      forEachDescendant(sf, (node) => {
        const method = zodRootMethod(node)
        if (method === undefined) return
        // Report only the outermost construction so a nested chain
        // (`z.object({ a: z.string() })`) yields a single, actionable issue.
        if (hasZodRootAncestor(node)) return

        const { line, column } = positionOf(sf, node)
        issues.push(makeIssue(file.relPath, line, column, method))
      })
    }
    return issues
  },
}

/**
 * The method name of a Zod-chain root call — `z.<method>(...)` whose receiver is
 * the bare `z` identifier — or `undefined` if `node` is not one. Chained methods
 * (`z.string().email()`) are *not* roots: their receiver is the previous call,
 * not `z`, so only the chain's first `z.<method>()` matches.
 */
function zodRootMethod(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== ZOD_NAMESPACE) {
    return undefined
  }
  return callee.name.text
}

/** True when any ancestor of `node` is itself a Zod-chain root call. */
function hasZodRootAncestor(node: ts.Node): boolean {
  let current = node.parent
  while (current) {
    if (zodRootMethod(current) !== undefined) return true
    current = current.parent
  }
  return false
}

/** `src/modules/users/users.route.ts` → `users.schema.ts` (the colocated target). */
function schemaFileNameFor(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  return base.replace(/\.(route|service)\.ts$/, '.schema.ts')
}

function makeIssue(file: string, line: number, column: number, method: string): Issue {
  const schemaFile = schemaFileNameFor(file)
  return {
    rule: NAME,
    severity: 'error',
    file,
    line,
    column,
    message: `Zod schema built inline with z.${method}(...) — schemas must live in ${schemaFile}`,
    why: 'ADR-0005: every domain keeps its Zod schemas in `src/modules/<domain>/<domain>.schema.ts`. Inline schemas in routes/services cannot be reused by name, drift into duplicates, and make "find every use of this shape" a fuzzy grep instead of an exact symbol search. Schema files also colocate the `z.infer` types with their schemas.',
    fix: `Move this schema into ${schemaFile} as a named export (e.g. \`export const FooSchema = z.object({ ... })\`) and import it here by name.`,
    example: {
      bad: [
        '// users.route.ts',
        'defineRoute({',
        "  method: 'POST',",
        "  path: '/users',",
        '  input: { body: z.object({ name: z.string() }) },',
        '  output: UserSchema,',
        '  handler: async (c) => createUser(c.input.body),',
        '})',
      ].join('\n'),
      good: [
        '// users.schema.ts',
        'export const CreateUserBodySchema = z.object({ name: z.string() })',
        '',
        '// users.route.ts',
        "import { CreateUserBodySchema } from './users.schema'",
        'defineRoute({',
        "  method: 'POST',",
        "  path: '/users',",
        '  input: { body: CreateUserBodySchema },',
        '  output: UserSchema,',
        '  handler: async (c) => createUser(c.input.body),',
        '})',
      ].join('\n'),
    },
  }
}
