/** Public API of `@kata/verify`. */
export type { CliResult } from './cli'
export { runCli } from './cli'
export { formatHookOutput, formatHuman, renderIssue } from './format'
export { extractRegistryKeys } from './registry'
export { rules } from './rules'
export { runVerify } from './runner'
export type {
  HookOutput,
  Issue,
  Project,
  Rule,
  Severity,
  SourceFile,
  VerifyResult,
} from './types'
