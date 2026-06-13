// Issue #28 — the `.codex/hooks.json` a freshly `kata init`-ed project gets.
//
// The Codex mirror of `.claude/settings.json`: same `kata verify --json`
// command, same three events, same Stop timeout. The *only* difference is the
// matcher — `Bash|apply_patch` instead of `Write|Edit|MultiEdit` — because
// Codex matches on tool names and has no Write/Edit/MultiEdit tools (the
// article's note about Codex's tool-name limitation). Codex also has no
// `permissions.deny` slot, so the commit/push bans are enforced by
// `kata verify` on PreToolUse rather than declared here.

import { CODEX_TOOL_MATCHER, harnessHooks } from './harness.js'
import type { CodexHooks } from './types.js'

export const codexHooksTemplate: CodexHooks = {
  hooks: harnessHooks(CODEX_TOOL_MATCHER),
}
