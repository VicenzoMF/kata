/** Public API of `@katajs/verify`. */
export type { CliResult } from './cli'
export { resolveTarget, runCli } from './cli'
export type { FormatOptions } from './format'
export { formatHookOutput, formatHuman, renderIssue, renderSuppression } from './format'
export type { ReadFile } from './generate-manifest'
export { generateManifest, serializeManifest } from './generate-manifest'
export type { ManifestLoader } from './manifest'
export { createManifestLoader, parseManifest } from './manifest'
export type { MiddlewareResolver, ResolvedMiddleware, SlotRead } from './middleware-graph'
export { createMiddlewareResolver } from './middleware-graph'
export type { AstCache } from './project'
export { createAstCache, createProject } from './project'
export { extractRegistryKeys, extractScopedKeys } from './registry'
export { rules } from './rules'
export { buildProject, runVerify, verifyProject } from './runner'
export type {
  HookOutput,
  Issue,
  ManifestEntry,
  Project,
  ProvidesManifest,
  Rule,
  RuleResult,
  Severity,
  SourceFile,
  Suppression,
  VerifyResult,
} from './types'
export type { WatchOptions, WatchRenderer, WatchSession } from './watch'
export { createWatchSession, watchProject } from './watch'
