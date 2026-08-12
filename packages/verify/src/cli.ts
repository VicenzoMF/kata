/**
 * CLI argument handling for `kata verify`. Kept pure — `runCli` returns the
 * output string and an exit code rather than touching `process` — so it can be
 * exercised directly in tests. The executable wrapper lives in `main.ts`, which
 * also dispatches the long-running `--watch` mode (see `watch.ts`).
 *
 * Usage:
 *   kata verify [path]                    human-readable report (exit 1 on any error)
 *   kata verify [path] --json             PostToolUse hook JSON on stdout (always exit 0)
 *   kata verify [path] --strict-coverage  also exit 1 when a rule suppressed itself
 *   kata verify [path] --watch            re-check on file changes (handled in main.ts)
 *   kata verify --help
 */
import { resolve } from 'node:path'

import { formatHookOutput, formatHuman } from './format'
import { runVerify } from './runner'

export type CliResult = {
  readonly output: string
  readonly exitCode: number
}

const HELP = `kata verify — fast deterministic checks for Kata projects

Usage:
  kata verify [path]          Check the project at [path] (default: cwd)
  kata verify [path] --json   Emit Claude Code PostToolUse hook JSON
  kata verify [path] --watch  Re-check on every file change (Ctrl-C to stop)
  kata verify --help          Show this help

Flags:
  --strict-coverage           Fail (exit 1) when a rule could not prove a check
                              and suppressed itself — an unresolvable middleware
                              expression, an indeterminate context registry. Use
                              in CI to keep coverage gaps from passing silently.

Rules:
  kata/no-route-without-output-schema   every defineRoute declares output         (ADR-0003)
  kata/no-route-without-input-schema    every defineRoute declares input          (ADR-0003)
  kata/inline-schema                    Zod schemas live in *.schema.ts           (ADR-0005)
  kata/scoped-slot-not-provided         scoped c.get has a providing middleware   (ADR-0004)
  kata/scoped-read-outside-request      scoped c.get only inside a request handler (ADR-0004)
  kata/middleware-provides-mismatch     provides[] matches the handler's c.set    (ADR-0004)
  kata/context-key-not-registered       c.get('key') is a registered context key  (ADR-0004)
`

/** Resolve the target directory from argv (first positional, default cwd). */
export function resolveTarget(argv: readonly string[], cwd: string): string {
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  return positional[0] ? resolve(cwd, positional[0]) : cwd
}

export function runCli(argv: readonly string[], cwd: string): CliResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { output: HELP, exitCode: 0 }
  }

  const json = argv.includes('--json')
  const strictCoverage = argv.includes('--strict-coverage')
  const result = runVerify(resolveTarget(argv, cwd))

  if (json) {
    // Always exit 0 in JSON mode: the hook payload carries the decision, and a
    // non-zero exit would surface stderr instead of the JSON to the agent.
    const output = JSON.stringify(formatHookOutput(result, { strictCoverage }), null, 2)
    return { output: `${output}\n`, exitCode: 0 }
  }

  // Under --strict-coverage a suppressed check fails the run on its own: the
  // point of the flag is that "could not prove it" and "proved it" must not
  // share an exit code (issue #206).
  const failed = result.errorCount > 0 || (strictCoverage && result.suppressions.length > 0)
  return { output: formatHuman(result, { strictCoverage }), exitCode: failed ? 1 : 0 }
}
