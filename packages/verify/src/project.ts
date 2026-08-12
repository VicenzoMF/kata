/**
 * Assembling the shared {@link Project} the rules run against, and the AST cache
 * hanging off it.
 *
 * Every rule needs the same files parsed. Before the cache each rule called
 * `parseSource` itself, so a 13-rule run re-parsed the whole project ~13× (and
 * `kata/scoped-slot-not-provided` alone parsed every file three times). The
 * cache makes `project.ast(file)` the single parse point: the first caller pays
 * for `ts.createSourceFile`, everyone after reuses the tree.
 *
 * Entries are keyed by path and validated against the file's exact text rather
 * than a digest — the text *is* the strongest possible content hash, and
 * comparing two identical strings is a pointer check in V8 before it is a
 * character scan. Watch mode therefore reuses every unchanged file's AST across
 * re-checks by handing each snapshot the same cache (see `watch.ts`); the one
 * file that changed misses on text, re-parses, and replaces its entry.
 */
import type ts from 'typescript'

import { parseSource } from './parse'
import type { Project, SourceFile } from './types'

/** Parse `file`, reusing the previous tree when its text is unchanged. */
export type AstCache = (file: SourceFile) => ts.SourceFile

export function createAstCache(): AstCache {
  const cache = new Map<string, { text: string; ast: ts.SourceFile }>()
  return (file) => {
    const hit = cache.get(file.path)
    if (hit && hit.text === file.text) return hit.ast
    const ast = parseSource(file.path, file.text)
    cache.set(file.path, { text: file.text, ast })
    return ast
  }
}

/**
 * Build a {@link Project} from already-read files, attaching an AST cache. Pass
 * `ast` to share one cache across successive projects (watch mode); omit it for
 * a one-shot run — and in tests, where it keeps hand-built projects a one-liner.
 *
 * `packageManifest` defaults to "no package ships one", which is also the right
 * answer for a hand-built test project: imports from npm packages stay
 * unresolvable unless the test declares otherwise.
 */
export function createProject(
  fields: Omit<Project, 'ast' | 'packageManifest'> & Partial<Pick<Project, 'packageManifest'>>,
  ast: AstCache = createAstCache(),
): Project {
  return { packageManifest: () => null, ...fields, ast }
}
