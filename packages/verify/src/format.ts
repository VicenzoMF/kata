/**
 * Rendering. Two surfaces share one issue renderer:
 *  - {@link formatHuman} — a terminal report for `kata verify`.
 *  - {@link formatHookOutput} — the JSON a Claude Code PostToolUse hook injects
 *    via `kata verify --json`.
 *
 * Each issue renders with the harness-engineering ERROR / WHY / FIX / EXAMPLE
 * template, so the same actionable text reaches both a human reader and the
 * agent's context window.
 */
import type { HookOutput, Issue, VerifyResult } from './types'

/** Render one issue as an ERROR / WHY / FIX / EXAMPLE block. */
export function renderIssue(issue: Issue): string {
  return [
    `ERROR: ${issue.message}`,
    `  ${issue.file}:${issue.line}:${issue.column}  [${issue.rule}]`,
    '',
    `  WHY: ${issue.why}`,
    '',
    `  FIX: ${issue.fix}`,
    '',
    '  EXAMPLE:',
    '    // Bad:',
    indent(issue.example.bad, 4),
    '    // Good:',
    indent(issue.example.good, 4),
  ].join('\n')
}

/** Human-readable terminal report. */
export function formatHuman(result: VerifyResult): string {
  if (result.issues.length === 0) {
    return `✓ kata verify: no problems found (${result.fileCount} file${plural(result.fileCount)} checked)\n`
  }
  const blocks = result.issues.map(renderIssue).join('\n\n')
  const n = result.issues.length
  return `${blocks}\n\n✖ ${n} problem${plural(n)} (${result.errorCount} error${plural(result.errorCount)})\n`
}

/**
 * The PostToolUse hook payload. On a clean run it is an empty object (a no-op
 * hook result). On violations it both injects the full report as
 * `hookSpecificOutput.additionalContext` and sets `decision: 'block'` with a
 * one-line `reason`, so the agent is told to fix the issues rather than merely
 * shown them.
 */
export function formatHookOutput(result: VerifyResult): HookOutput {
  if (result.issues.length === 0) return {}

  const n = result.issues.length
  const header = `kata verify found ${n} violation${plural(n)}. Fix ${n === 1 ? 'it' : 'each'} before continuing:`
  const additionalContext = `${header}\n\n${result.issues.map(renderIssue).join('\n\n')}`

  return {
    decision: 'block',
    reason: `kata verify found ${n} violation${plural(n)}.`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext,
    },
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n')
}

function plural(n: number): string {
  return n === 1 ? '' : 's'
}
