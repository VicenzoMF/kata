/**
 * The verification pipeline: discover a project's source files, build the
 * shared {@link Project} (file list + context registry), run every rule, and
 * roll the issues up into a {@link VerifyResult}.
 *
 * Split into {@link buildProject} (disk discovery) and {@link verifyProject}
 * (pure rule run) so watch mode can re-run rules over an incrementally-updated
 * project without re-reading the whole tree.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { collectSourceFiles } from './fs-walk'
import { extractRegistryKeys, extractScopedKeys } from './registry'
import { rules } from './rules'
import type { Issue, Project, VerifyResult } from './types'

/** Verify the Kata project rooted at `targetDir`. Pure: no process exit, no I/O beyond reads. */
export function runVerify(targetDir: string): VerifyResult {
  return verifyProject(buildProject(targetDir))
}

/** Run every rule over an already-built project and roll the issues into a result. Pure, no I/O. */
export function verifyProject(project: Project): VerifyResult {
  const issues = [...rules.flatMap((rule) => rule.check(project))].sort(byLocation)
  return {
    issues,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    fileCount: project.files.length,
  }
}

/** Discover the source files and context registry of the project rooted at `targetDir`. */
export function buildProject(targetDir: string): Project {
  const srcDir = join(targetDir, 'src')
  const files = existsSync(srcDir) ? collectSourceFiles(srcDir, targetDir) : []

  const contextPath = join(srcDir, 'context.ts')
  const contextSource = existsSync(contextPath) ? readFileSync(contextPath, 'utf8') : null
  const registryKeys = contextSource !== null ? extractRegistryKeys(contextSource) : null
  const scopedKeys = contextSource !== null ? extractScopedKeys(contextSource) : null

  return { root: targetDir, files, registryKeys, scopedKeys }
}

function byLocation(a: Issue, b: Issue): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0
}
