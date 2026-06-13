// Shapes for the harness config files `kata init` generates. These mirror the
// documented Claude Code (`settings.json`) and Codex (`hooks.json`) schemas,
// narrowed to the slots the Kata harness actually uses. They exist so the
// templates below are checked at compile time — a malformed template is a type
// error, not a runtime surprise in a downstream project.

/** A single hook invocation. `timeout` (seconds) is only set on the slow Stop
 *  ladder; Claude/Codex both default it for the fast Pre/PostToolUse hooks. */
export type HookCommand = {
  type: 'command'
  command: string
  timeout?: number
}

/** A matcher → commands group. `matcher` is omitted for events that have no
 *  tool to match against (Stop fires once, unconditionally). */
export type HookGroup = {
  matcher?: string
  hooks: readonly HookCommand[]
}

/** The three harness events, shared by both the Claude and Codex configs. */
export type HookEvents = {
  PreToolUse?: readonly HookGroup[]
  PostToolUse?: readonly HookGroup[]
  Stop?: readonly HookGroup[]
}

/** `.claude/settings.json` (issue #27). */
export type ClaudeSettings = {
  $schema: string
  permissions: { deny: readonly string[] }
  hooks: HookEvents
}

/** `.codex/hooks.json` (issue #28). Codex has no `permissions` slot. */
export type CodexHooks = {
  hooks: HookEvents
}
