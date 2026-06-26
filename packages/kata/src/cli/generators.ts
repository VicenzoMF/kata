// Pure renderers: template → exact on-disk file content. No file I/O lives
// here (that's `init.ts`), so these are trivially testable and the generated
// bytes are asserted directly in generators.test.ts.

import { agentsHooksTemplate } from './templates/agents-hooks'
import { agentsMd } from './templates/agents-md'
import { biomeJsonTemplate } from './templates/biome-json'
import { claudeMd } from './templates/claude-md'
import { claudeSettingsTemplate } from './templates/claude-settings'
import { codexHooksTemplate } from './templates/codex-hooks'
import {
  exampleAppSource,
  exampleContextSource,
  exampleGitignoreSource,
  exampleGreetingsHurlSource,
  exampleGreetingsRouteSource,
  exampleGreetingsSchemaSource,
  exampleGreetingsServiceSource,
  exampleGreetingsTestSource,
  exampleHealthHurlSource,
  exampleHealthRouteSource,
  exampleHealthSchemaSource,
  exampleHealthServiceSource,
  exampleHealthTestSource,
  exampleMainSource,
  examplePackageJson,
  exampleReadme,
  exampleRequestLoggerSource,
  exampleTsconfigSource,
} from './templates/example'
import { lefthookYmlTemplate } from './templates/lefthook-yml'
import { oxlintrcJson } from './templates/oxlintrc-json'

/** Serialise a template to its on-disk form: 2-space JSON + trailing newline,
 *  matching Biome's JSON formatter so the generated file is already canonical
 *  and won't be reformatted on the project's first harness run. */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ── Harness config files (`.claude` / `.codex` / `.agents` + the md pair) ─────

/** Render `.claude/settings.json` for a new project (issues #27, #29). */
export function renderClaudeSettings(): string {
  return serialize(claudeSettingsTemplate)
}

/** Render `.codex/hooks.json` for a new project (issue #28). */
export function renderCodexHooks(): string {
  return serialize(codexHooksTemplate)
}

/** Render `.agents/hooks.json` — the vendor-neutral hook mirror (issue #200). */
export function renderAgentsHooks(): string {
  return serialize(agentsHooksTemplate)
}

/** Render `AGENTS.md` — the canonical agent instructions (issue #31). */
export function renderAgentsMd(): string {
  return agentsMd
}

/** Render `CLAUDE.md` — the Claude entrypoint that imports AGENTS.md (#31). */
export function renderClaudeMd(): string {
  return claudeMd
}

/** Render `lefthook.yml` — the local feedback layer (#130). */
export function renderLefthookYml(): string {
  return lefthookYmlTemplate
}

/** Render `biome.json` — the formatter config the generated lefthook runs (#200). */
export function renderBiomeJson(): string {
  return serialize(biomeJsonTemplate)
}

/** Render `.oxlintrc.json` — the linter config the generated lefthook runs (#200). */
export function renderOxlintrc(): string {
  return oxlintrcJson
}

// ── `kata init` app source files (issue #200) ────────────────────────────────
// The sources are stored pre-rendered in `templates/example.ts`; these renderers
// stay thin re-exports, symmetric with the harness generators above. The
// manifests serialise an object (like the JSON harness templates) so the bytes
// match Biome's JSON formatter.

/** Render `src/context.ts` — the typed DI surface (ADR-0004). */
export function renderExampleContext(): string {
  return exampleContextSource
}

/** Render `src/app.ts` — `createApp({ modules, middlewares })` (AGENTS.md layout). */
export function renderExampleApp(): string {
  return exampleAppSource
}

/** Render `src/main.ts` — runtime entry wiring the app to `serve`. */
export function renderExampleMain(): string {
  return exampleMainSource
}

/** Render `src/middlewares/request-logger.ts` — the example middleware (ADR-0012). */
export function renderExampleRequestLogger(): string {
  return exampleRequestLoggerSource
}

/** Render `src/modules/health/health.schema.ts` — the `HealthSchema` DTO (ADR-0005). */
export function renderExampleHealthSchema(): string {
  return exampleHealthSchemaSource
}

/** Render `src/modules/health/health.service.ts` — the pure liveness check. */
export function renderExampleHealthService(): string {
  return exampleHealthServiceSource
}

/** Render `src/modules/health/health.route.ts` — `GET /health` (ADR-0003). */
export function renderExampleHealthRoute(): string {
  return exampleHealthRouteSource
}

/** Render `src/modules/health/health.test.ts` — the service unit test. */
export function renderExampleHealthTest(): string {
  return exampleHealthTestSource
}

/** Render `src/modules/health/health.hurl` — the API E2E. */
export function renderExampleHealthHurl(): string {
  return exampleHealthHurlSource
}

/** Render `src/modules/greetings/greetings.schema.ts` — the greetings DTOs (ADR-0005). */
export function renderExampleGreetingsSchema(): string {
  return exampleGreetingsSchemaSource
}

/** Render `src/modules/greetings/greetings.service.ts` — pure logic + store. */
export function renderExampleGreetingsService(): string {
  return exampleGreetingsServiceSource
}

/** Render `src/modules/greetings/greetings.route.ts` — `POST` + `GET /:id` (ADR-0003). */
export function renderExampleGreetingsRoute(): string {
  return exampleGreetingsRouteSource
}

/** Render `src/modules/greetings/greetings.test.ts` — the service unit tests. */
export function renderExampleGreetingsTest(): string {
  return exampleGreetingsTestSource
}

/** Render `src/modules/greetings/greetings.hurl` — the end-to-end API E2E. */
export function renderExampleGreetingsHurl(): string {
  return exampleGreetingsHurlSource
}

/** Render `.gitignore` for the generated app. */
export function renderExampleGitignore(): string {
  return exampleGitignoreSource
}

/** Render the generated app's `README.md`, titled after the project (#200). */
export function renderExampleReadme(name: string): string {
  return exampleReadme(name)
}

/** Render the generated app's `package.json` (emitted only-if-absent), named
 *  after the target directory. */
export function renderExamplePackageJson(name: string): string {
  return serialize(examplePackageJson(name))
}

/** Render the generated app's `tsconfig.json` (emitted only-if-absent). */
export function renderExampleTsconfig(): string {
  return exampleTsconfigSource
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
