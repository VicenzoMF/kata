// Shared harness constants and the hook-map builder both configs are made
// from. Centralising these is what makes Claude/Codex parity hold *by
// construction* (#27/#28: "parity is the point") — the two templates can only
// differ where this module lets them differ (the tool matcher), never in the
// commands they run or the timeout they allow.

import type { PackageManagerCommands } from '../package-manager'
import type { HookCommand, HookEvents } from './types'

/** The fast-loop command Pre/PostToolUse shell out to. A freshly `kata
 *  init`-ed project only has `kata` in `node_modules/.bin`, never on PATH
 *  (#231), so the command must resolve it through the detected package
 *  manager's local-bin runner (`pm.exec`) instead of assuming a global
 *  `kata`. `kata verify` reads the hook event from stdin and emits the right
 *  shape per event. See CLAUDE.md / AGENTS.md: "`kata verify` — fast determ
 *  checks; use `--json` for hook output." */
export function verifyCommand(pm: PackageManagerCommands): string {
  return pm.exec('kata verify --json')
}

/** The Stop gate runs the project's test suite. `kata verify` is a fast lint
 *  engine, not a test runner, so "done" is gated on the actual tests (#30) —
 *  mirroring this repo's own reference Stop hook, which runs the test ladder.
 *  Both halves resolve through the detected package manager (#231): `pm.exec`
 *  for the `kata` bin, `pm.run` for the scaffolded `package.json`'s `test`
 *  script — never a bare `kata` or a hardcoded `pnpm test`. */
export function stopCommand(pm: PackageManagerCommands): string {
  return `${pm.exec('kata verify')} && ${pm.run('test')}`
}

/** Stop runs the test suite; give it headroom over the millisecond Pre/Post
 *  hooks. Matches the timeout on this repo's own reference Stop hook. */
export const STOP_TIMEOUT_SECONDS = 180

/** Claude Code matches on tool names, so it can target file-writing tools. */
export const CLAUDE_EDIT_MATCHER = 'Write|Edit|MultiEdit'

/** Codex only exposes `Bash`/`apply_patch` tool names (#28) — it cannot match
 *  Write/Edit/MultiEdit, so writes are detected from the Bash command itself. */
export const CODEX_TOOL_MATCHER = 'Bash|apply_patch'

/** Vendor-neutral matcher for the generic `.agents/hooks.json` (issue #200): the
 *  union of the file-writing tool names both conventions use, so any harness that
 *  adopts the emerging `.agents/` directory matches whichever names it exposes.
 *  `.agents/` has no published schema yet; this mirror reuses the same hook
 *  commands as the Claude/Codex configs so the three stay in lockstep. */
export const AGENTS_TOOL_MATCHER = 'Write|Edit|MultiEdit|Bash|apply_patch'

/** Commit/push cheat paths the harness bans via Claude's `permissions.deny`
 *  (ADR-0010). Codex has no equivalent slot, so `kata verify` enforces the same
 *  set there on PreToolUse — the ban is identical across harnesses. */
export const DENY_COMMANDS: readonly string[] = [
  'Bash(git commit *--no-verify*)',
  'Bash(git commit *-n *)',
  'Bash(git push *--no-verify*)',
  'Bash(SKIP=*)',
]

/** The config / framework / harness files an agent must not rewrite to silence
 *  a failing check (#29, ADR-0010). Gitignore-style globs matched relative to
 *  the project root — the single source the deny rules below are built from. */
export const PROTECTED_CONFIG_GLOBS: readonly string[] = [
  'tsconfig.json',
  'tsconfig.*.json',
  'biome.json',
  '.oxlintrc*',
  'lefthook.yml',
  'kata.config.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.github/workflows/**',
  '.claude/settings.json',
  '.codex/hooks.json',
]

/** The write tools a deny rule must name. Claude permission rules are
 *  per-tool, so each protected path is denied once per write tool. */
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit']

/** Per-tool `permissions.deny` rules protecting {@link PROTECTED_CONFIG_GLOBS}.
 *  Claude enforces these natively — no `kata verify` install required — so a
 *  freshly `kata init`-ed project is protected from session one (#29, ADR-0010).
 *  Codex has no deny slot; its PreToolUse hook enforces the same set. */
export const DENY_CONFIG_EDITS: readonly string[] = EDIT_TOOLS.flatMap((tool) =>
  PROTECTED_CONFIG_GLOBS.map((glob) => `${tool}(${glob})`),
)

/** JSON Schema the generated Claude settings declare for editor validation. */
export const CLAUDE_SETTINGS_SCHEMA = 'https://json.schemastore.org/claude-code-settings.json'

function commandHook(command: string, timeoutSeconds?: number): HookCommand {
  if (timeoutSeconds === undefined) {
    return { type: 'command', command }
  }
  return { type: 'command', command, timeout: timeoutSeconds }
}

/** Build the three-event hook map shared by both harnesses. Only the tool
 *  matcher differs between Claude and Codex; the commands, the events, and the
 *  Stop timeout are identical — the entire point of #27/#28. Pre/Post run the
 *  fast `kata verify` loop; Stop runs the test suite (#30). `pm` is the
 *  detected package manager (#231) — every command it builds resolves the
 *  local `kata` bin and the local `test` script instead of assuming a global
 *  `kata` and a pnpm toolchain. */
export function harnessHooks(toolMatcher: string, pm: PackageManagerCommands): HookEvents {
  const verify = commandHook(verifyCommand(pm))
  return {
    PreToolUse: [{ matcher: toolMatcher, hooks: [verify] }],
    PostToolUse: [{ matcher: toolMatcher, hooks: [verify] }],
    Stop: [{ hooks: [commandHook(stopCommand(pm), STOP_TIMEOUT_SECONDS)] }],
  }
}
