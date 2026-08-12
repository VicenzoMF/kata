/**
 * Rendering. Two surfaces share one issue renderer:
 *  - {@link formatHuman} — a terminal report for `kata verify`.
 *  - {@link formatHookOutput} — the JSON a Claude Code PostToolUse hook injects
 *    via `kata verify --json`.
 *
 * Each issue renders with the harness-engineering ERROR / WHY / FIX / EXAMPLE
 * template, so the same actionable text reaches both a human reader and the
 * agent's context window.
 *
 * Both surfaces also report {@link Suppression}s — checks a rule declined to
 * make. A clean report that hides them is the bug issue #206 was filed for: one
 * unresolvable `cors()` switched `kata/scoped-slot-not-provided` off across the
 * whole project while the run still printed "no problems found".
 */
import type { HookOutput, Issue, Suppression, VerifyResult } from './types'

/** Options shared by both renderers. */
export type FormatOptions = {
  /** Treat suppressions as failures (`--strict-coverage`): changes wording, not content. */
  readonly strictCoverage?: boolean
}

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

/** Render one suppression as a two-line `⚠` entry. */
export function renderSuppression(suppression: Suppression): string {
  const { rule, reason, file, line, column, affectedCount } = suppression
  const scope =
    affectedCount > 0
      ? `suppressed for ${affectedCount} check${plural(affectedCount)}`
      : 'suppressed'
  return `⚠ ${rule}: ${scope} — ${reason}\n    ${file}:${line}:${column}`
}

/** The `⚠` section listing every check that did not run, or `null` when all ran. */
function renderSuppressions(result: VerifyResult, options: FormatOptions): string | null {
  if (result.suppressions.length === 0) return null

  const n = result.suppressions.length
  const header = `⚠ ${n} check${plural(n)} suppressed — a rule could not prove its property here:`
  const footer = options.strictCoverage
    ? '--strict-coverage: an unproven check counts as a failure.'
    : 'A suppressed rule is not a passing rule. Re-run with --strict-coverage to fail on these.'
  const entries = result.suppressions.map((s) => indent(renderSuppression(s), 2)).join('\n')
  return `${header}\n${entries}\n\n${footer}`
}

/** Human-readable terminal report. */
export function formatHuman(result: VerifyResult, options: FormatOptions = {}): string {
  const suppressions = renderSuppressions(result, options)

  if (result.issues.length === 0) {
    const clean = `✓ kata verify: no problems found (${result.fileCount} file${plural(result.fileCount)} checked)`
    return suppressions === null ? `${clean}\n` : `${clean}\n\n${suppressions}\n`
  }

  const blocks = result.issues.map(renderIssue).join('\n\n')
  const n = result.issues.length
  const summary = `✖ ${n} problem${plural(n)} (${result.errorCount} error${plural(result.errorCount)})`
  const body = suppressions === null ? blocks : `${blocks}\n\n${suppressions}`
  return `${body}\n\n${summary}\n`
}

/**
 * The PostToolUse hook payload. On a clean run with nothing suppressed it is an
 * empty object (a no-op hook result). On violations it both injects the full
 * report as `hookSpecificOutput.additionalContext` and sets `decision: 'block'`
 * with a one-line `reason`, so the agent is told to fix the issues rather than
 * merely shown them.
 *
 * Suppressions ride along in both forms — prose in `additionalContext`, and the
 * structured `suppressions` array for any consumer that wants to act on them.
 * On their own they inform without blocking: the code they cover may well be
 * correct, and the agent's move is to make it *resolvable*, not to guess. Under
 * `strictCoverage` they block like a violation, matching the CLI's exit code.
 */
export function formatHookOutput(result: VerifyResult, options: FormatOptions = {}): HookOutput {
  const n = result.issues.length
  const suppressed = result.suppressions.length
  if (n === 0 && suppressed === 0) return {}

  const sections: string[] = []
  if (n > 0) {
    const header = `kata verify found ${n} violation${plural(n)}. Fix ${n === 1 ? 'it' : 'each'} before continuing:`
    sections.push(`${header}\n\n${result.issues.map(renderIssue).join('\n\n')}`)
  }
  if (suppressed > 0) {
    const header = `kata verify could not check everything: ${suppressed} suppressed check${plural(suppressed)}. These rules proved nothing here — make the flagged expression resolvable (or accept the gap deliberately):`
    sections.push(`${header}\n\n${result.suppressions.map(renderSuppression).join('\n\n')}`)
  }

  const blocking = n > 0 || (options.strictCoverage === true && suppressed > 0)
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse' as const,
      additionalContext: sections.join('\n\n'),
    },
    ...(suppressed > 0 ? { suppressions: result.suppressions } : {}),
  }

  return blocking ? { decision: 'block', reason: blockReason(result), ...payload } : payload
}

/** One-line `reason` for a blocking hook result: violations if any, else the coverage gap. */
function blockReason(result: VerifyResult): string {
  const n = result.issues.length
  if (n > 0) return `kata verify found ${n} violation${plural(n)}.`
  const suppressed = result.suppressions.length
  return `kata verify suppressed ${suppressed} check${plural(suppressed)} (--strict-coverage).`
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
