/**
 * CLI argument handling for `kata verify`. Kept pure — `runCli` returns the
 * output string and an exit code rather than touching `process` — so it can be
 * exercised directly in tests. The executable wrapper lives in `main.ts`, which
 * also dispatches the long-running `--watch` mode (see `watch.ts`).
 *
 * Usage:
 *   kata verify [path]          human-readable report (exit 1 on any error)
 *   kata verify [path] --json   PostToolUse hook JSON on stdout (always exit 0)
 *   kata verify [path] --watch  re-check on file changes (handled in main.ts)
 *   kata verify --help
 */
import { resolve } from 'node:path'

import { formatHookOutput, formatHuman } from './format'
import { rules } from './rules'
import { runVerify } from './runner'

export type CliResult = {
  readonly output: string
  readonly exitCode: number
}

/**
 * Render the `Rules:` block from {@link rules} so `--help` cannot drift from
 * what `kata verify` actually runs (issue #212). Column widths are computed
 * from the longest name/description rather than hardcoded.
 */
function renderRulesHelp(): string {
  const nameWidth = Math.max(...rules.map((rule) => rule.name.length)) + 3
  const descWidth = Math.max(...rules.map((rule) => rule.description.length)) + 3
  return rules
    .map(
      (rule) =>
        `  ${rule.name.padEnd(nameWidth)}${rule.description.padEnd(descWidth)}(${rule.adr})`,
    )
    .join('\n')
}

const HELP = `kata verify — fast deterministic checks for Kata projects

Usage:
  kata verify [path]          Check the project at [path] (default: cwd)
  kata verify [path] --json   Emit Claude Code PostToolUse hook JSON
  kata verify [path] --watch  Re-check on every file change (Ctrl-C to stop)
  kata verify --help          Show this help

Rules:
${renderRulesHelp()}
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
  const result = runVerify(resolveTarget(argv, cwd))

  if (json) {
    // Always exit 0 in JSON mode: the hook payload carries the decision, and a
    // non-zero exit would surface stderr instead of the JSON to the agent.
    return { output: `${JSON.stringify(formatHookOutput(result), null, 2)}\n`, exitCode: 0 }
  }

  return { output: formatHuman(result), exitCode: result.errorCount > 0 ? 1 : 0 }
}
