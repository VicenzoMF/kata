// Pure renderers: template → exact on-disk file content. No file I/O lives
// here (that's `init.ts`), so these are trivially testable and the generated
// bytes are asserted directly in generators.test.ts.

import { agentsMd } from './templates/agents-md'
import { claudeMd } from './templates/claude-md'
import { claudeSettingsTemplate } from './templates/claude-settings'
import { codexHooksTemplate } from './templates/codex-hooks'

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
