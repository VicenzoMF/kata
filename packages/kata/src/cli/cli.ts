// CLI surface for the `kata` binary. Kept side-effect free — `run` returns the
// streams to write and the exit code rather than touching `process` — so the
// whole command is testable without spawning a subprocess. `main.ts` is the
// only place that talks to `process`.

import { type InitResult, init } from './init'

export type ParsedArgs = {
  command: string | undefined
  cwd: string | undefined
  force: boolean
  help: boolean
  withExample: boolean
}

export type RunResult = {
  code: number
  stdout: string
  stderr: string
}

export const HELP_TEXT = `kata — agent-driven web framework with the harness shipped natively

Usage:
  kata init [options]    Scaffold harness config files into a project

Options:
  -C, --cwd <dir>     Project root to scaffold into (default: current directory)
  -f, --force         Overwrite existing files instead of skipping them
      --with-example  Also scaffold a runnable example app (GET /health)
  -h, --help          Show this help

\`kata init\` writes:
  .claude/settings.json    Claude Code hooks + config-tampering bans (#27, #29)
  .codex/hooks.json        Codex hooks → \`kata verify --json\` (#28)
  AGENTS.md                Canonical agent instructions, Codex + Claude (#31)
  CLAUDE.md                Claude entrypoint → imports AGENTS.md (#31)

\`--with-example\` additionally writes a runnable app — run \`pnpm install\`, then
\`pnpm start\`, to boot \`GET /health\`:
  src/context.ts                        defineContext + re-export createApp/defineRoute
  src/main.ts                           createApp({ modules: [health] }) + serve
  src/modules/health/health.route.ts    GET /health → 200 {"status":"ok"}
  src/modules/health/health.schema.ts   HealthSchema (Zod DTO)
  package.json, tsconfig.json           created only if absent
`

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | undefined
  let cwd: string | undefined
  let force = false
  let help = false
  let withExample = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '-f' || arg === '--force') {
      force = true
    } else if (arg === '--with-example') {
      withExample = true
    } else if (arg === '-C' || arg === '--cwd') {
      i += 1
      cwd = argv[i]
    } else if (arg.startsWith('--cwd=')) {
      cwd = arg.slice('--cwd='.length)
    } else if (command === undefined && !arg.startsWith('-')) {
      command = arg
    }
  }

  return { command, cwd, force, help, withExample }
}

/** Human-readable summary of what `init` did. */
export function formatResult(result: InitResult): string {
  const mark: Record<InitResult['files'][number]['status'], string> = {
    created: 'create',
    overwritten: 'update',
    skipped: '  skip',
  }

  const lines = [`kata init → ${result.cwd}`]
  for (const file of result.files) {
    lines.push(`  ${mark[file.status]}  ${file.path}`)
  }

  if (result.files.some((file) => file.status === 'skipped')) {
    lines.push('')
    lines.push('Some files already existed and were left untouched.')
    lines.push('Re-run with --force to overwrite them.')
  }

  return `${lines.join('\n')}\n`
}

/** Parse args, dispatch, and return the streams + exit code to emit. */
export async function run(argv: readonly string[]): Promise<RunResult> {
  const args = parseArgs(argv)

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

  if (args.command !== 'init') {
    return {
      code: 1,
      stdout: '',
      stderr: `kata: unknown command '${args.command}'\n\n${HELP_TEXT}`,
    }
  }

  const result = await init({ cwd: args.cwd, force: args.force, withExample: args.withExample })
  return { code: 0, stdout: formatResult(result), stderr: '' }
}
