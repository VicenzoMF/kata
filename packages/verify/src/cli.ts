/**
 * CLI argument handling for `kata verify`. Kept pure — `runCli` returns the
 * output string and an exit code rather than touching `process` — so it can be
 * exercised directly in tests. The executable wrapper lives in `main.ts`.
 *
 * Usage:
 *   kata verify [path]          human-readable report (exit 1 on any error)
 *   kata verify [path] --json   PostToolUse hook JSON on stdout (always exit 0)
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
  kata verify --help          Show this help

Rules:
  kata/no-route-without-output-schema   every defineRoute declares output (ADR-0003)
  kata/context-key-not-registered       c.get('key') is registered            (ADR-0004)
`

export function runCli(argv: readonly string[], cwd: string): CliResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { output: HELP, exitCode: 0 }
  }

  const json = argv.includes('--json')
  const positional = argv.filter((arg) => !arg.startsWith('-'))
  const targetDir = positional[0] ? resolve(cwd, positional[0]) : cwd

  const result = runVerify(targetDir)

  if (json) {
    // Always exit 0 in JSON mode: the hook payload carries the decision, and a
    // non-zero exit would surface stderr instead of the JSON to the agent.
    return { output: `${JSON.stringify(formatHookOutput(result), null, 2)}\n`, exitCode: 0 }
  }

  return { output: formatHuman(result), exitCode: result.errorCount > 0 ? 1 : 0 }
}
