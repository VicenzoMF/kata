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
} from './generators'

export type InitOptions = {
  /** Project root to scaffold into. Defaults to `process.cwd()`. */
  cwd?: string
  /** Overwrite existing files instead of skipping them. */
  force?: boolean
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
}

/** The harness files `kata init` writes — Claude settings (#27, #29), Codex
 *  hooks (#28), and the AGENTS.md / CLAUDE.md instruction pair (#31). */
const TARGETS: readonly Target[] = [
  { path: '.claude/settings.json', render: renderClaudeSettings },
  { path: '.codex/hooks.json', render: renderCodexHooks },
  { path: 'AGENTS.md', render: renderAgentsMd },
  { path: 'CLAUDE.md', render: renderClaudeMd },
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

  if (present && !force) {
    return { path: target.path, status: 'skipped' }
  }

  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, target.render(), 'utf8')
  return { path: target.path, status: present ? 'overwritten' : 'created' }
}

/** Generate the harness config files for a project, creating parent
 *  directories as needed. Returns a per-file report rather than logging, so
 *  the CLI layer owns all output and the function stays testable. The targets
 *  are independent files, so they are written concurrently; `Promise.all`
 *  preserves their order in the report. */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const force = options.force ?? false
  const files = await Promise.all(TARGETS.map((target) => writeTarget(cwd, force, target)))
  return { cwd, files }
}
