/** Public API of `@kata/verify`. */
export type { CliResult } from './cli'
export { resolveTarget, runCli } from './cli'
export { formatHookOutput, formatHuman, renderIssue } from './format'
export { extractRegistryKeys, extractScopedKeys } from './registry'
export { rules } from './rules'
export { buildProject, runVerify, verifyProject } from './runner'
export type {
  HookOutput,
  Issue,
  Project,
  Rule,
  Severity,
  SourceFile,
  VerifyResult,
} from './types'
export type { WatchOptions, WatchRenderer, WatchSession } from './watch'
export { createWatchSession, watchProject } from './watch'
