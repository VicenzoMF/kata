// Issue #200 — the `.agents/hooks.json` a freshly `kata init`-ed project gets.
//
// A vendor-neutral mirror of `.claude/settings.json` and `.codex/hooks.json`:
// the same Pre/PostToolUse → `kata verify --json` loop and the same
// `kata verify && pnpm test` Stop gate, so a harness that reads the emerging
// `.agents/` convention runs the identical checks the Claude and Codex configs
// do. `.agents/` has no published schema yet, so this keeps to the shared
// hook-map shape (no vendor-specific `permissions` / `$schema` slot, like the
// Codex config) and uses the union tool matcher. AGENTS.md carries the
// vendor-neutral *instructions*; this file carries the vendor-neutral *hooks*.

import { AGENTS_TOOL_MATCHER, harnessHooks } from './harness'
import type { CodexHooks } from './types'

export const agentsHooksTemplate: CodexHooks = {
  hooks: harnessHooks(AGENTS_TOOL_MATCHER),
}
