// Issues #28 / #29 — the `.codex/hooks.json` a freshly `kata init`-ed project
// gets.
//
// The Codex mirror of `.claude/settings.json`: same `kata verify --json`
// Pre/PostToolUse command, same `pnpm test` Stop gate, same Stop timeout. The
// *only* structural difference is the matcher — `Bash|apply_patch` instead of
// `Write|Edit|MultiEdit` — because Codex matches on tool names and has no
// Write/Edit/MultiEdit tools (the article's note on Codex's tool-name limit).
//
// Codex also has no `permissions.deny` slot, so both ban sets Claude declares
// there — the commit/push bypasses and the config-tampering edits (#29,
// ADR-0010) — are enforced by `kata verify` on PreToolUse instead.

import { CODEX_TOOL_MATCHER, harnessHooks } from './harness'
import type { CodexHooks } from './types'

export const codexHooksTemplate: CodexHooks = {
  hooks: harnessHooks(CODEX_TOOL_MATCHER),
}
