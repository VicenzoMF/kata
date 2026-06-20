// Pure renderers: template → exact on-disk file content. No file I/O lives
// here (that's `init.ts`), so these are trivially testable and the generated
// bytes are asserted directly in generators.test.ts.

import { agentsMd } from './templates/agents-md'
import { claudeMd } from './templates/claude-md'
import { claudeSettingsTemplate } from './templates/claude-settings'
import { codexHooksTemplate } from './templates/codex-hooks'
import {
  exampleContextSource,
  exampleHealthRouteSource,
  exampleHealthSchemaSource,
  exampleMainSource,
  examplePackageJson,
  exampleTsconfig,
} from './templates/example'

/** Serialise a template to its on-disk form: 2-space JSON + trailing newline,
 *  matching Biome's JSON formatter so the generated file is already canonical
 *  and won't be reformatted on the project's first harness run. */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Render `.claude/settings.json` for a new project (issues #27, #29). */
export function renderClaudeSettings(): string {
  return serialize(claudeSettingsTemplate)
}

/** Render `.codex/hooks.json` for a new project (issue #28). */
export function renderCodexHooks(): string {
  return serialize(codexHooksTemplate)
}

/** Render `AGENTS.md` — the canonical agent instructions (issue #31). */
export function renderAgentsMd(): string {
  return agentsMd
}

/** Render `CLAUDE.md` — the Claude entrypoint that imports AGENTS.md (#31). */
export function renderClaudeMd(): string {
  return claudeMd
}

// ── `kata init --with-example` source files (ADR-0015 / issue #101) ──────────
// The four source files are stored pre-rendered in `templates/example.ts`; these
// renderers stay thin re-exports, symmetric with the markdown generators above.
// The two manifests serialise an object (like the JSON harness templates) so the
// bytes match Biome's JSON formatter.

/** Render `src/context.ts` — the typed DI surface (ADR-0004). */
export function renderExampleContext(): string {
  return exampleContextSource
}

/** Render `src/main.ts` — entry point wiring `createApp` to `serve`. */
export function renderExampleMain(): string {
  return exampleMainSource
}

/** Render `src/modules/health/health.route.ts` — `GET /health` (ADR-0003). */
export function renderExampleHealthRoute(): string {
  return exampleHealthRouteSource
}

/** Render `src/modules/health/health.schema.ts` — the `HealthSchema` DTO (ADR-0005). */
export function renderExampleHealthSchema(): string {
  return exampleHealthSchemaSource
}

/** Render the generated app's `package.json` (emitted only-if-absent). */
export function renderExamplePackageJson(): string {
  return serialize(examplePackageJson)
}

/** Render the generated app's `tsconfig.json` (emitted only-if-absent). */
export function renderExampleTsconfig(): string {
  return serialize(exampleTsconfig)
}

// ── `kata new <domain>` source files (Issue #102) ──────────

import {
  moduleHurlSource,
  moduleRouteSource,
  moduleSchemaSource,
  moduleServiceSource,
  moduleTestSource,
} from './templates/new'

export function renderModuleRoute(domain: string): string {
  return moduleRouteSource(domain)
}

export function renderModuleService(domain: string): string {
  return moduleServiceSource(domain)
}

export function renderModuleSchema(domain: string): string {
  return moduleSchemaSource(domain)
}

export function renderModuleTest(domain: string): string {
  return moduleTestSource(domain)
}

export function renderModuleHurl(domain: string): string {
  return moduleHurlSource(domain)
}
