// CLI surface for the `kata` binary. Kept side-effect free — `run` returns the
// streams to write and the exit code rather than touching `process` — so the
// whole command is testable without spawning a subprocess. `main.ts` is the
// only place that talks to `process`.

import { runCli } from '@kata/verify'

import { type InitResult, init } from './init'
import { createModule, type NewResult } from './new'

export type ParsedArgs = {
  command: string | undefined
  domain: string | undefined
  /** Target directory for `init` (the `[dir]` positional). */
  dir: string | undefined
  cwd: string | undefined
  force: boolean
  help: boolean
  /** `--minimal`: write only the harness configs, no runnable app. */
  minimal: boolean
}

export type RunResult = {
  code: number
  stdout: string
  stderr: string
}

export const HELP_TEXT = `kata — agent-driven web framework with the harness shipped natively

Usage:
  kata init [dir]        Scaffold a new Kata app (runnable project + harness)
  kata new <domain>      Generate a new module under src/modules/<domain>/
  kata verify [path]     Run Kata's lint rules over a project (default path: cwd)

Options:
  -C, --cwd <dir>     Base directory to resolve [dir] against (default: cwd)
      --minimal       Write only the harness configs — no app (for existing projects)
  -f, --force         Overwrite existing source files (never the manifests/configs)
  -h, --help          Show this help

\`kata init [dir]\` scaffolds a complete, runnable app following the AGENTS.md
layout — src/app.ts, src/context.ts, middlewares/, and two example modules
(GET /health, POST + GET /greetings) — on top of the agent harness
(.claude / .codex / .agents + AGENTS.md / CLAUDE.md) and a lefthook pre-commit:

  kata init my-app
  cd my-app && pnpm install
  pnpm dev          # → http://localhost:3000/health
  kata verify

\`--minimal\` writes only the harness configs, for adding Kata to an existing
project. \`kata verify\` enforces ADR-0003/0004/0005; \`kata verify --json\` emits
Claude Code PostToolUse hook JSON. Run \`kata verify --help\` for its flags.
`

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | undefined
  let domain: string | undefined
  let dir: string | undefined
  let cwd: string | undefined
  let force = false
  let help = false
  let minimal = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '-f' || arg === '--force') {
      force = true
    } else if (arg === '--minimal') {
      minimal = true
    } else if (arg === '-C' || arg === '--cwd') {
      i += 1
      const next = argv[i]
      if (next === undefined || next.startsWith('-')) {
        throw new Error('kata: --cwd requires a directory value')
      }
      cwd = next
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length)
    } else if (arg.startsWith('-')) {
      // Unknown flag — ignored (back-compat: never hard-fail on an extra flag).
    } else if (command === undefined) {
      command = arg
    } else if (command === 'new' && domain === undefined) {
      domain = arg
    } else if (command === 'init' && dir === undefined) {
      dir = arg
    }
  }

  return { command, domain, dir, cwd, force, help, minimal }
}

const STATUS_MARK: Record<InitResult['files'][number]['status'], string> = {
  created: 'create',
  overwritten: 'update',
  skipped: '  skip',
}

/** The `cd … && pnpm install && …` block printed after a successful `init`. */
function nextSteps(result: InitResult): string[] {
  if (result.minimal) {
    return [
      'Harness configs written. Commit them, then start coding —',
      'the PreToolUse/Stop hooks run `kata verify` and `pnpm test` for you.',
    ]
  }
  const steps = ['Next steps:']
  if (result.dir !== '.') steps.push(`  cd ${result.dir}`)
  steps.push('  pnpm install')
  steps.push('  pnpm dev          # → http://localhost:3000/health')
  steps.push('  kata verify       # fast deterministic checks')
  steps.push('  pnpm test         # unit tests')
  return steps
}

/** Human-readable summary of what `init` did, plus the next steps. */
export function formatResult(result: InitResult): string {
  const lines = [`kata init → ${result.cwd}`]
  for (const file of result.files) {
    lines.push(`  ${STATUS_MARK[file.status]}  ${file.path}`)
  }

  if (result.files.some((file) => file.status === 'skipped')) {
    lines.push('')
    lines.push('Some files already existed and were left untouched.')
    lines.push('Re-run with --force to overwrite source files (manifests are never touched).')
  }

  lines.push('')
  lines.push(...nextSteps(result))

  return `${lines.join('\n')}\n`
}

/** Human-readable summary of what `new` did. */
export function formatNewResult(result: NewResult): string {
  const lines = [`kata new ${result.domain} → ${result.cwd}`]
  for (const file of result.files) {
    lines.push(`  ${STATUS_MARK[file.status]}  ${file.path}`)
  }

  if (result.files.some((file) => file.status === 'skipped')) {
    lines.push('')
    lines.push('Some files already existed and were left untouched.')
    lines.push('Re-run with --force to overwrite them.')
  }

  return `${lines.join('\n')}\n`
}

/**
 * If `argv` is a `verify` invocation, return the args that follow the `verify`
 * token so `@kata/verify`'s CLI sees them exactly as it would standalone;
 * otherwise return `null`. The command is the first non-flag arg (matching
 * `parseArgs`). Exported so `main.ts` can route the long-running `--watch` mode.
 */
export function verifyArgv(argv: readonly string[]): string[] | null {
  const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'))
  if (commandIndex < 0 || argv[commandIndex] !== 'verify') return null
  return [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)]
}

/** Parse args, dispatch, and return the streams + exit code to emit. */
export async function run(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<RunResult> {
  const verifyArgs = verifyArgv(argv)
  if (verifyArgs) {
    // Delegate to @kata/verify's pure CLI. `--watch` never reaches here — it is
    // long-running and dispatched in main.ts — so runCli only does single-shot
    // (human or --json) runs, which already return an output string + exit code.
    const { output, exitCode } = runCli(verifyArgs, cwd)
    return { code: exitCode, stdout: output, stderr: '' }
  }

  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  }

  if (args.help) {
    return { code: 0, stdout: HELP_TEXT, stderr: '' }
  }

  if (args.command === undefined) {
    return {
      code: 1,
      stdout: '',
      stderr: `kata: missing command (try \`kata init\`)\n\n${HELP_TEXT}`,
    }
  }

  if (args.command !== 'init' && args.command !== 'new') {
    return {
      code: 1,
      stdout: '',
      stderr: `kata: unknown command '${args.command}'\n\n${HELP_TEXT}`,
    }
  }

  if (args.command === 'new') {
    if (!args.domain) {
      return {
        code: 1,
        stdout: '',
        stderr: `kata new: missing domain name\n\n${HELP_TEXT}`,
      }
    }
    const result = await createModule({ domain: args.domain, cwd: args.cwd, force: args.force })
    return { code: 0, stdout: formatNewResult(result), stderr: '' }
  }

  const result = await init({
    cwd: args.cwd,
    dir: args.dir,
    force: args.force,
    minimal: args.minimal,
  })
  return { code: 0, stdout: formatResult(result), stderr: '' }
}
