// Issue #27 — the `.claude/settings.json` a freshly `kata init`-ed project gets.
//
// Mirrors the *shape* of this repo's own reference settings (PreToolUse /
// PostToolUse / Stop + the `permissions.deny` cheat-path bans), but every hook
// shells out to `kata verify --json` instead of the repo-local
// `.claude/hooks/*.sh` scripts: a downstream project depends on the published
// `kata` CLI, not on our bespoke scripts. The PostToolUse hook injecting
// feedback via `kata verify --json` is the load-bearing line of the issue.

import { CLAUDE_EDIT_MATCHER, CLAUDE_SETTINGS_SCHEMA, DENY_COMMANDS, harnessHooks } from './harness'
import type { ClaudeSettings } from './types'

export const claudeSettingsTemplate: ClaudeSettings = {
  $schema: CLAUDE_SETTINGS_SCHEMA,
  permissions: { deny: DENY_COMMANDS },
  hooks: harnessHooks(CLAUDE_EDIT_MATCHER),
}
