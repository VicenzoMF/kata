// `kata init [dir]` — scaffold a new Kata project (issue #200). By default it
// writes the full canonical app (AGENTS.md layout: app.ts, context.ts,
// middlewares/, two example modules) on top of the agent harness, so a newcomer
// goes from zero to a running server in one command. `--minimal` writes only the
// harness configs — the original behaviour, for adding Kata to an existing
// project. This supersedes ADR-0015 D1 (which scaffolded a minimal two-file app
// behind `--with-example`).
//
// Idempotent by default: an existing file is left untouched (status `skipped`)
// unless `force` is set, so re-running never clobbers a tweaked file silently.
// The manifests/configs (`package.json`, `tsconfig.json`, `biome.json`,
// `.oxlintrc.json`, `.gitignore`, `README.md`) are `onlyIfAbsent` — never
// overwritten, even with `--force`, because clobbering a real project's manifest
// is never the intent of a re-run.

import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  renderAgentsHooks,
  renderAgentsMd,
  renderBiomeJson,
  renderClaudeMd,
  renderClaudeSettings,
  renderCodexHooks,
  renderExampleApp,
  renderExampleContext,
  renderExampleGitignore,
  renderExampleGreetingsHurl,
  renderExampleGreetingsRoute,
  renderExampleGreetingsSchema,
  renderExampleGreetingsService,
  renderExampleGreetingsTest,
  renderExampleHealthHurl,
  renderExampleHealthRoute,
  renderExampleHealthSchema,
  renderExampleHealthService,
  renderExampleHealthTest,
  renderExampleMain,
  renderExamplePackageJson,
  renderExampleReadme,
  renderExampleRequestLogger,
  renderExampleTsconfig,
  renderLefthookYml,
  renderOxlintrc,
} from './generators'

export type InitOptions = {
  /** Base directory the target is resolved against. Defaults to `process.cwd()`. */
  cwd?: string
  /** Target directory (the `[dir]` positional), relative to `cwd`. Created if
   *  missing; defaults to `cwd` itself. */
  dir?: string
  /** Overwrite existing source files instead of skipping them. Never applies to
   *  the `onlyIfAbsent` manifests/configs. */
  force?: boolean
  /** Write only the harness configs — no runnable app. For adding Kata to an
   *  existing project (the pre-#200 default). */
  minimal?: boolean
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
  /** The target as the user named it (`dir`, or `.` for the current directory) —
   *  used by the CLI to print the `cd` next-step hint. */
  dir: string
  /** Whether this was a harness-only (`--minimal`) run. */
  minimal: boolean
  files: readonly GeneratedFile[]
}

type Target = {
  path: string
  render: () => string
  /**
   * When set, the file is written only if it does not already exist and is
   * *never* overwritten — `--force` does not apply. Used for the generated
   * manifests/configs, which a real project is likely to have customised;
   * clobbering one is never the intent of a re-run.
   */
  onlyIfAbsent?: boolean
}

/** The agent-harness files `kata init` always writes (both full and `--minimal`
 *  runs): Claude settings (#27, #29), Codex hooks (#28), the vendor-neutral
 *  `.agents` mirror (#200), the AGENTS.md / CLAUDE.md instruction pair (#31), and
 *  the lefthook pre-commit config (#130). */
const HARNESS_TARGETS: readonly Target[] = [
  { path: '.claude/settings.json', render: renderClaudeSettings },
  { path: '.codex/hooks.json', render: renderCodexHooks },
  { path: '.agents/hooks.json', render: renderAgentsHooks },
  { path: 'AGENTS.md', render: renderAgentsMd },
  { path: 'CLAUDE.md', render: renderClaudeMd },
  { path: 'lefthook.yml', render: renderLefthookYml },
]

/** The runnable app a full `kata init` writes on top of the harness (issue #200):
 *  the canonical `src/` layout plus the manifests/configs that make it boot,
 *  typecheck, test, and pass the harness from commit 1. The `src/` files honour
 *  `--force`; the manifests/configs are `onlyIfAbsent`. `name` titles the
 *  generated `package.json` / `README.md`. */
function appTargets(name: string): readonly Target[] {
  return [
    // Lint/format configs the generated lefthook.yml runs (onlyIfAbsent).
    { path: 'biome.json', render: renderBiomeJson, onlyIfAbsent: true },
    { path: '.oxlintrc.json', render: renderOxlintrc, onlyIfAbsent: true },
    // App source — the canonical AGENTS.md layout.
    { path: 'src/context.ts', render: renderExampleContext },
    { path: 'src/app.ts', render: renderExampleApp },
    { path: 'src/main.ts', render: renderExampleMain },
    { path: 'src/middlewares/request-logger.ts', render: renderExampleRequestLogger },
    // health module (GET).
    { path: 'src/modules/health/health.schema.ts', render: renderExampleHealthSchema },
    { path: 'src/modules/health/health.service.ts', render: renderExampleHealthService },
    { path: 'src/modules/health/health.route.ts', render: renderExampleHealthRoute },
    { path: 'src/modules/health/health.test.ts', render: renderExampleHealthTest },
    { path: 'src/modules/health/health.hurl', render: renderExampleHealthHurl },
    // greetings module (POST + GET).
    { path: 'src/modules/greetings/greetings.schema.ts', render: renderExampleGreetingsSchema },
    { path: 'src/modules/greetings/greetings.service.ts', render: renderExampleGreetingsService },
    { path: 'src/modules/greetings/greetings.route.ts', render: renderExampleGreetingsRoute },
    { path: 'src/modules/greetings/greetings.test.ts', render: renderExampleGreetingsTest },
    { path: 'src/modules/greetings/greetings.hurl', render: renderExampleGreetingsHurl },
    // Manifests + docs (onlyIfAbsent).
    { path: 'package.json', render: () => renderExamplePackageJson(name), onlyIfAbsent: true },
    { path: 'tsconfig.json', render: renderExampleTsconfig, onlyIfAbsent: true },
    { path: '.gitignore', render: renderExampleGitignore, onlyIfAbsent: true },
    { path: 'README.md', render: () => renderExampleReadme(name), onlyIfAbsent: true },
  ]
}

/** Derive an npm-safe package name from the target directory's basename. Falls
 *  back to `kata-app` when the basename yields nothing usable (e.g. `/`). */
export function appNameFromDir(target: string): string {
  const cleaned = basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-{2,}/g, '-')
  return cleaned.length > 0 ? cleaned : 'kata-app'
}

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

  // `onlyIfAbsent` targets (the generated manifests/configs) ignore `--force`: an
  // existing one is always left untouched.
  const mayOverwrite = force && !target.onlyIfAbsent
  if (present && !mayOverwrite) {
    return { path: target.path, status: 'skipped' }
  }

  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, target.render(), 'utf8')
  return { path: target.path, status: present ? 'overwritten' : 'created' }
}

/**
 * Scaffold a Kata project, creating parent directories as needed. Writes the
 * agent harness always; with the full (non-`minimal`) run, also the runnable app
 * (issue #200). Returns a per-file report rather than logging, so the CLI layer
 * owns all output and the function stays testable. The targets are independent
 * files, so they are written concurrently; `Promise.all` preserves their order
 * in the report.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const cwd = resolve(options.cwd ?? process.cwd(), options.dir ?? '.')
  const force = options.force ?? false
  const minimal = options.minimal ?? false
  const targets = minimal
    ? HARNESS_TARGETS
    : [...HARNESS_TARGETS, ...appTargets(appNameFromDir(cwd))]
  const files = await Promise.all(targets.map((target) => writeTarget(cwd, force, target)))
  return { cwd, dir: options.dir ?? '.', minimal, files }
}
