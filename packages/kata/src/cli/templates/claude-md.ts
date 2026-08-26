// Issue #31 — the `CLAUDE.md` a freshly `kata init`-ed project gets. Mirrors
// this repo's own setup: a thin Claude Code entrypoint that imports the
// canonical `AGENTS.md` via the `@`-include directive, then adds the
// Claude-specific harness notes. Keeping `CLAUDE.md` a pointer (not a copy) is
// what keeps Codex and Claude reading the same instructions.
//
// Newline-joined line array, same reasoning as `agents-md.ts`.

import { type PackageManager, pmCommands } from '../package-manager'

/** `pm` is the package manager detected for the target project (issue #302) —
 *  the Stop-hook line names the actual test command instead of assuming pnpm,
 *  matching the harness hooks (issue #231) and `agents-md.ts`. */
function lines(pm: PackageManager): readonly string[] {
  const { run } = pmCommands(pm)
  return [
    '# Claude Code Instructions',
    '',
    'See @AGENTS.md for the canonical instructions (shared with Codex and other',
    'agents).',
    '',
    'Claude-specific notes:',
    '- `.claude/settings.json` wires the harness hooks (PreToolUse / PostToolUse /',
    '  Stop) and the config-tampering `permissions.deny` bans.',
    '- PreToolUse / PostToolUse run `kata verify --json`; the PostToolUse hook',
    '  injects remaining findings as `hookSpecificOutput.additionalContext` so the',
    '  fix lands on the next turn.',
    `- Stop runs \`${run('test')}\` — a red suite blocks ending the session.`,
  ]
}

/** The exact `CLAUDE.md` bytes (newline-joined, trailing newline) `kata init`
 *  writes for the given package manager (issue #302), symmetric with
 *  {@link agentsMd}. */
export function claudeMd(pm: PackageManager): string {
  return `${lines(pm).join('\n')}\n`
}
