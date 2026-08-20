// CLI surface for the `kata` binary. Kept side-effect free — `run` returns the
// streams to write and the exit code rather than touching `process` — so the
// whole command is testable without spawning a subprocess. `main.ts` is the
// only place that talks to `process`.

import { type InitResult, init } from './init'
import type { NewResult } from './new'
import { pmCommands } from './package-manager'

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
  /** `--with-docs-mcp`: also write `.mcp.json`, registering the
   *  `@katajs-framework/docs-mcp` docs-search server (ADR-0023). */
  docsMcp: boolean
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
      --with-docs-mcp Also write .mcp.json, registering the @katajs-framework/docs-mcp docs-search server
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
  let docsMcp = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '-f' || arg === '--force') {
      force = true
    } else if (arg === '--minimal') {
      minimal = true
    } else if (arg === '--with-docs-mcp') {
      docsMcp = true
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

  return { command, domain, dir, cwd, force, help, minimal, docsMcp }
}

const STATUS_MARK: Record<InitResult['files'][number]['status'], string> = {
  created: 'create',
  overwritten: 'update',
  skipped: '  skip',
}

/** The `cd … && <install> && …` block printed after a successful `init`, in
 *  the detected package manager's own spelling (issue #214) — a bare `kata`
 *  after `--minimal` guidance is fine (nothing to run yet), but a full scaffold
 *  must print commands that actually work on the first try, not a pnpm-only
 *  script + a `kata` bin that is never on PATH after an npm/yarn/bun install. */
function nextSteps(result: InitResult): string[] {
  if (result.minimal) {
    return [
      'Harness configs written. Commit them, then start coding —',
      'the PreToolUse/Stop hooks run `kata verify` and `pnpm test` for you.',
    ]
  }
  const pm = pmCommands(result.packageManager)
  const steps = ['Next steps:']
  if (result.dir !== '.') steps.push(`  cd ${result.dir}`)
  steps.push(`  ${pm.install}`)
  steps.push(`  ${pm.run('dev')}          # → http://localhost:3000/health`)
  steps.push(`  ${pm.exec('kata verify')}       # fast deterministic checks`)
  steps.push(`  ${pm.run('test')}         # unit tests`)
  if (result.docsMcp) {
    steps.push('')
    steps.push('.mcp.json registers @katajs-framework/docs-mcp via `npx` — requires it to be')
    steps.push('published to npm first (see the Kata repo for current status).')
  }
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

/** Human-readable summary of what `new` did, including whether it wired the
 *  module into `src/app.ts` (issue #214) — a module that never got imported
 *  and registered is dead code no matter how correct its five files are. */
export function formatNewResult(result: NewResult): string {
  const lines = [`kata new ${result.domain} → ${result.cwd}`]
  for (const file of result.files) {
    lines.push(`  ${STATUS_MARK[file.status]}  ${file.path}`)
  }

  const wiring = result.appWiring
  if (wiring.status === 'wired') {
    lines.push(`  ${STATUS_MARK.overwritten}  src/app.ts`)
  } else if (wiring.status === 'already-wired') {
    lines.push(`  ${STATUS_MARK.skipped}  src/app.ts (already wired)`)
  } else if (wiring.status === 'unrecognized' || wiring.status === 'missing') {
    lines.push('')
    lines.push(
      wiring.status === 'missing'
        ? 'src/app.ts not found. Wire the module up yourself, adding:'
        : "src/app.ts doesn't match the expected createApp({ modules: [...] }) shape.",
    )
    if (wiring.status === 'unrecognized') lines.push('Wire it up yourself, adding:')
    for (const paste of wiring.pasteLines) lines.push(`  ${paste}`)
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
 * token so `@katajs-framework/verify`'s CLI sees them exactly as it would standalone;
 * otherwise return `null`. The command is the first non-flag arg (matching
 * `parseArgs`). Exported so `main.ts` can route the long-running `--watch` mode.
 */
export function verifyArgv(argv: readonly string[]): string[] | null {
  const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'))
  if (commandIndex < 0 || argv[commandIndex] !== 'verify') return null
  return [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)]
}

/** Parse args, dispatch, and return the streams + exit code to emit. */
/**
 * Load a module that needs the TypeScript compiler.
 *
 * `typescript` is an *optional* peer dependency, so `npm install` does not pull
 * it in. Without this, the reader gets a raw ESM resolution failure naming an
 * internal bundle chunk — true, but not actionable. Only the commands that
 * actually parse TypeScript (`verify`, `new`) can hit this; `init` never does.
 */
async function importNeedingTypescript<T>(load: () => Promise<T>, command: string): Promise<T> {
  try {
    return await load()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("Cannot find package 'typescript'")) throw error
    throw new Error(
      `${command} needs the TypeScript compiler, an optional peer dependency that is not installed.\n` +
        'Install it with: npm install -D typescript',
      { cause: error },
    )
  }
}

export async function run(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<RunResult> {
  const verifyArgs = verifyArgv(argv)
  if (verifyArgs) {
    // Delegate to @katajs-framework/verify's pure CLI. `--watch` never reaches here — it is
    // long-running and dispatched in main.ts — so runCli only does single-shot
    // (human or --json) runs, which already return an output string + exit code.
    //
    // Imported dynamically: the verifier pulls in `typescript`, an *optional*
    // peer that npm therefore does not install. A static import puts that
    // `import 'typescript'` at the top of the CLI bundle, so `kata init` — which
    // never parses TypeScript — would crash with ERR_MODULE_NOT_FOUND before
    // doing anything. `splitting: true` keeps it in a chunk loaded only here.
    const { runCli } = await importNeedingTypescript(
      () => import('@katajs-framework/verify'),
      'verify',
    )
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
    // Dynamic for the same reason as the verifier above: `./new` wires the new
    // module into `src/app.ts`, which parses it with `typescript`.
    const { createModule } = await importNeedingTypescript(() => import('./new'), 'new')
    const result = await createModule({ domain: args.domain, cwd: args.cwd, force: args.force })
    return { code: 0, stdout: formatNewResult(result), stderr: '' }
  }

  const result = await init({
    cwd: args.cwd,
    dir: args.dir,
    force: args.force,
    minimal: args.minimal,
    docsMcp: args.docsMcp,
  })
  return { code: 0, stdout: formatResult(result), stderr: '' }
}
