// `kata init` — the one entrypoint both config generators sit behind. Writes
// the harness configs into a project. Idempotent by default: an existing file
// is left untouched (status `skipped`) unless `force` is set, so re-running
// `kata init` in a project that already has a tweaked settings file never
// clobbers it silently.

import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  renderAgentsMd,
  renderClaudeMd,
  renderClaudeSettings,
  renderCodexHooks,
  renderExampleContext,
  renderExampleHealthRoute,
  renderExampleHealthSchema,
  renderExampleMain,
  renderExamplePackageJson,
  renderExampleTsconfig,
} from './generators'

export type InitOptions = {
  /** Project root to scaffold into. Defaults to `process.cwd()`. */
  cwd?: string
  /** Overwrite existing files instead of skipping them. */
  force?: boolean
  /** Also scaffold the runnable example app (`GET /health`) — ADR-0015 D1. */
  withExample?: boolean
}

export type FileStatus = 'created' | 'overwritten' | 'skipped'

export type GeneratedFile = {
  /** Path relative to the project root, e.g. `.claude/settings.json`. */
  path: string
  status: FileStatus
}

export type InitResult = {
  /** Absolute project root the files were written under. */
  cwd: string
  files: readonly GeneratedFile[]
}

type Target = {
  path: string
  render: () => string
  /**
   * When set, the file is written only if it does not already exist and is
   * *never* overwritten — `--force` does not apply (ADR-0015). Used for the
   * generated `package.json` / `tsconfig.json`, which a real project is likely
   * to have customised; clobbering a manifest is never the intent of a re-run.
   */
  onlyIfAbsent?: boolean
}

/** The harness files `kata init` writes — Claude settings (#27, #29), Codex
 *  hooks (#28), and the AGENTS.md / CLAUDE.md instruction pair (#31). */
const TARGETS: readonly Target[] = [
  { path: '.claude/settings.json', render: renderClaudeSettings },
  { path: '.codex/hooks.json', render: renderCodexHooks },
  { path: 'AGENTS.md', render: renderAgentsMd },
  { path: 'CLAUDE.md', render: renderClaudeMd },
]

/** The runnable example app `kata init --with-example` adds on top of the harness
 *  files (ADR-0015 D1 / issue #101). The four source files ride the same
 *  created/overwritten/skipped path and honour `--force`; the `package.json` /
 *  `tsconfig.json` manifests are `onlyIfAbsent` so a re-run never clobbers them. */
const EXAMPLE_TARGETS: readonly Target[] = [
  { path: 'src/context.ts', render: renderExampleContext },
  { path: 'src/main.ts', render: renderExampleMain },
  { path: 'src/modules/health/health.route.ts', render: renderExampleHealthRoute },
  { path: 'src/modules/health/health.schema.ts', render: renderExampleHealthSchema },
  { path: 'package.json', render: renderExamplePackageJson, onlyIfAbsent: true },
  { path: 'tsconfig.json', render: renderExampleTsconfig, onlyIfAbsent: true },
]

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function writeTarget(cwd: string, force: boolean, target: Target): Promise<GeneratedFile> {
  const absolute = join(cwd, target.path)
  const present = await exists(absolute)

  // `onlyIfAbsent` targets (the generated manifests) ignore `--force`: an
  // existing one is always left untouched (ADR-0015).
  const mayOverwrite = force && !target.onlyIfAbsent
  if (present && !mayOverwrite) {
    return { path: target.path, status: 'skipped' }
  }

  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, target.render(), 'utf8')
  return { path: target.path, status: present ? 'overwritten' : 'created' }
}

/** Generate the harness config files for a project, creating parent
 *  directories as needed. With `withExample`, the runnable example app
 *  (`GET /health`) is appended to the same write path (ADR-0015). Returns a
 *  per-file report rather than logging, so the CLI layer owns all output and the
 *  function stays testable. The targets are independent files, so they are
 *  written concurrently; `Promise.all` preserves their order in the report. */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const force = options.force ?? false
  const targets = options.withExample ? [...TARGETS, ...EXAMPLE_TARGETS] : TARGETS
  const files = await Promise.all(targets.map((target) => writeTarget(cwd, force, target)))
  return { cwd, files }
}
