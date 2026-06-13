// Issues #27 / #29 — the `.claude/settings.json` a freshly `kata init`-ed
// project gets.
//
// Mirrors the *shape* of this repo's own reference settings (PreToolUse /
// PostToolUse / Stop + the `permissions.deny` bans), but the hooks shell out to
// the published `kata` CLI / `pnpm test` instead of the repo-local
// `.claude/hooks/*.sh` scripts: a downstream project depends on the published
// tooling, not on our bespoke scripts.
//
// `permissions.deny` carries the two ban sets ADR-0010 codifies: the
// commit/push verification bypasses (`DENY_COMMANDS`) and the config-tampering
// edit bans (`DENY_CONFIG_EDITS`, issue #29). Both are native Claude
// enforcement — they protect the project before any `kata verify` ruleset
// exists.

import {
  CLAUDE_EDIT_MATCHER,
  CLAUDE_SETTINGS_SCHEMA,
  DENY_COMMANDS,
  DENY_CONFIG_EDITS,
  harnessHooks,
} from './harness'
import type { ClaudeSettings } from './types'

export const claudeSettingsTemplate: ClaudeSettings = {
  $schema: CLAUDE_SETTINGS_SCHEMA,
  permissions: { deny: [...DENY_COMMANDS, ...DENY_CONFIG_EDITS] },
  hooks: harnessHooks(CLAUDE_EDIT_MATCHER),
}
