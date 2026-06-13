// Shared harness constants and the hook-map builder both configs are made
// from. Centralising these is what makes Claude/Codex parity hold *by
// construction* (#27/#28: "parity is the point") — the two templates can only
// differ where this module lets them differ (the tool matcher), never in the
// command they run or the timeout they allow.

import type { HookCommand, HookEvents } from './types'

/** The one command every harness hook shells out to. The generated configs
 *  reference the `kata` CLI as a command string rather than depending on its
 *  internals (it may not be built yet); `kata verify` reads the hook event
 *  from stdin and emits the right shape per event. See CLAUDE.md / AGENTS.md:
 *  "`kata verify` — fast determ checks; use `--json` for hook output." */
export const VERIFY_COMMAND = 'kata verify --json'

/** Stop runs the slow ladder (typecheck + test + E2E); give it headroom.
 *  Matches the timeout on this repo's own reference Stop hook. */
export const STOP_TIMEOUT_SECONDS = 180

/** Claude Code matches on tool names, so it can target file-writing tools. */
export const CLAUDE_EDIT_MATCHER = 'Write|Edit|MultiEdit'

/** Codex only exposes `Bash`/`apply_patch` tool names (#28) — it cannot match
 *  Write/Edit/MultiEdit, so writes are detected from the Bash command itself. */
export const CODEX_TOOL_MATCHER = 'Bash|apply_patch'

/** Commit/push cheat paths the harness bans via Claude's `permissions.deny`.
 *  Codex has no equivalent slot, so `kata verify` enforces the same set there
 *  on PreToolUse — the ban is identical across harnesses. */
export const DENY_COMMANDS: readonly string[] = [
  'Bash(git commit *--no-verify*)',
  'Bash(git commit *-n *)',
  'Bash(git push *--no-verify*)',
  'Bash(SKIP=*)',
]

/** JSON Schema the generated Claude settings declare for editor validation. */
export const CLAUDE_SETTINGS_SCHEMA = 'https://json.schemastore.org/claude-code-settings.json'

function verifyHook(timeoutSeconds?: number): HookCommand {
  if (timeoutSeconds === undefined) {
    return { type: 'command', command: VERIFY_COMMAND }
  }
  return { type: 'command', command: VERIFY_COMMAND, timeout: timeoutSeconds }
}

/** Build the three-event hook map shared by both harnesses. Only the tool
 *  matcher differs between Claude and Codex; the commands, the events, and the
 *  Stop timeout are identical — which is the entire point of #27/#28. */
export function harnessHooks(toolMatcher: string): HookEvents {
  return {
    PreToolUse: [{ matcher: toolMatcher, hooks: [verifyHook()] }],
    PostToolUse: [{ matcher: toolMatcher, hooks: [verifyHook()] }],
    Stop: [{ hooks: [verifyHook(STOP_TIMEOUT_SECONDS)] }],
  }
}
