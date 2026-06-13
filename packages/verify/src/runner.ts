/**
 * The verification pipeline: discover a project's source files, build the
 * shared {@link Project} (file list + context registry), run every rule, and
 * roll the issues up into a {@link VerifyResult}.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { collectSourceFiles } from './fs-walk'
import { extractRegistryKeys } from './registry'
import { rules } from './rules'
import type { Issue, Project, VerifyResult } from './types'

/** Verify the Kata project rooted at `targetDir`. Pure: no process exit, no I/O beyond reads. */
export function runVerify(targetDir: string): VerifyResult {
  const project = buildProject(targetDir)
  const issues = [...rules.flatMap((rule) => rule.check(project))].sort(byLocation)
  return {
    issues,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    fileCount: project.files.length,
  }
}

function buildProject(targetDir: string): Project {
  const srcDir = join(targetDir, 'src')
  const files = existsSync(srcDir) ? collectSourceFiles(srcDir, targetDir) : []

  const contextPath = join(srcDir, 'context.ts')
  const registryKeys = existsSync(contextPath)
    ? extractRegistryKeys(readFileSync(contextPath, 'utf8'))
    : null

  return { root: targetDir, files, registryKeys }
}

function byLocation(a: Issue, b: Issue): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0
}
