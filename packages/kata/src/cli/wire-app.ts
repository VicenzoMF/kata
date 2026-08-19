// Wires a `kata new <domain>` module into `src/app.ts` (issue #214, item 2):
// every module `kata new` generates used to be dead code until a human edited
// `app.ts` by hand. This inserts `import * as <domain> from
// './modules/<domain>/<domain>.route'` in sorted position and appends
// `<domain>` to the `modules` array literal passed to `createApp({ ... })`,
// via the TypeScript compiler API — idempotent (a second run detects the
// existing entry and no-ops) and immune to the formatting drift a regex
// splice would risk, because only the two spans it decides to touch are
// spliced; the rest of the file (comments, unrelated formatting) survives
// byte-for-byte, which a full `ts.createPrinter()` re-emit would not
// guarantee. `computeAppWiring` is pure text-in/text-out so it is testable
// without touching the filesystem; `wireAppModule` is the thin fs wrapper
// `new.ts` calls.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import ts from 'typescript'

export type WireOutcome =
  | { status: 'wired'; text: string }
  | { status: 'already-wired' }
  // `app.ts` has no unambiguous `createApp({ modules: [...] })` call with a
  // literal array — e.g. `modules` built from a variable or a spread, or no
  // `createApp` call at all. Bail rather than guess; `pasteLines` is what a
  // human adds by hand instead.
  | { status: 'unrecognized'; pasteLines: readonly string[] }
  | { status: 'missing'; pasteLines: readonly string[] }

type Edit = { start: number; end: number; text: string }

function wiringPasteLines(domain: string): readonly string[] {
  return [
    `import * as ${domain} from './modules/${domain}/${domain}.route'`,
    `// then add \`${domain}\` to the \`modules\` array passed to createApp({ ... })`,
  ]
}

/** The `modules` array literal of the (single, unambiguous) `createApp({ ... })`
 *  call in the file, or `undefined` when there is none or more than one. */
function findModulesArray(sf: ts.SourceFile): ts.ArrayLiteralExpression | undefined {
  let found: ts.ArrayLiteralExpression | undefined
  let ambiguous = false

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'createApp') {
        const config = node.arguments[0]
        if (config && ts.isObjectLiteralExpression(config)) {
          for (const member of config.properties) {
            if (
              ts.isPropertyAssignment(member) &&
              ts.isIdentifier(member.name) &&
              member.name.text === 'modules' &&
              ts.isArrayLiteralExpression(member.initializer)
            ) {
              if (found) ambiguous = true
              found = member.initializer
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return ambiguous ? undefined : found
}

/** Where to splice in `import * as <domain> from '<specifier>'` so the import
 *  block stays sorted by specifier, matching the scaffold's own convention. */
function computeImportInsertion(sf: ts.SourceFile, specifier: string, domain: string): Edit {
  const importLine = `import * as ${domain} from '${specifier}'`
  const importDecls = sf.statements.filter(ts.isImportDeclaration)

  for (const decl of importDecls) {
    if (!ts.isStringLiteral(decl.moduleSpecifier)) continue
    if (specifier < decl.moduleSpecifier.text) {
      const pos = decl.getStart(sf)
      return { start: pos, end: pos, text: `${importLine}\n` }
    }
  }

  const last = importDecls[importDecls.length - 1]
  if (last) {
    const pos = last.getEnd()
    return { start: pos, end: pos, text: `\n${importLine}` }
  }

  // No existing imports — insert at the top of the file.
  return { start: 0, end: 0, text: `${importLine}\n` }
}

/** Where to splice `, <domain>` (or just `<domain>` into an empty array) so it
 *  is appended as the last element, per the issue's "append" instruction. */
function computeArrayAppend(array: ts.ArrayLiteralExpression, domain: string): Edit {
  const lastElement = array.elements[array.elements.length - 1]
  if (!lastElement) {
    const pos = array.getEnd() - 1 // position of ']' in `[]`
    return { start: pos, end: pos, text: domain }
  }
  const pos = lastElement.getEnd()
  return { start: pos, end: pos, text: `, ${domain}` }
}

/** Apply edits highest-offset-first so an earlier edit's splice never shifts
 *  a later edit's already-computed offset. */
function applyEdits(source: string, edits: readonly Edit[]): string {
  let result = source
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

/** Pure core: given `src/app.ts`'s current text, compute the wired result (or
 *  why it can't be wired automatically). No I/O. */
export function computeAppWiring(source: string, domain: string): WireOutcome {
  const sf = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const modulesArray = findModulesArray(sf)
  if (!modulesArray) return { status: 'unrecognized', pasteLines: wiringPasteLines(domain) }

  const alreadyWired = modulesArray.elements.some((el) => ts.isIdentifier(el) && el.text === domain)
  if (alreadyWired) return { status: 'already-wired' }

  const specifier = `./modules/${domain}/${domain}.route`
  const text = applyEdits(source, [
    computeImportInsertion(sf, specifier, domain),
    computeArrayAppend(modulesArray, domain),
  ])
  return { status: 'wired', text }
}

/** Wire `<domain>` into `<cwd>/src/app.ts`, writing the file back when
 *  changed. Never throws — a missing or unrecognized `app.ts` is reported in
 *  the returned outcome so `kata new` can still report success on the five
 *  generated files and print the two lines to paste by hand. */
export async function wireAppModule(cwd: string, domain: string): Promise<WireOutcome> {
  const path = join(cwd, 'src/app.ts')
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch {
    return { status: 'missing', pasteLines: wiringPasteLines(domain) }
  }

  const outcome = computeAppWiring(source, domain)
  if (outcome.status === 'wired') {
    await writeFile(path, outcome.text, 'utf8')
  }
  return outcome
}
