import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  renderAgentsHooks,
  renderClaudeSettings,
  renderExampleApp,
  renderExamplePackageJson,
} from './generators'
import { appNameFromDir, type FileStatus, type InitResult, init } from './init'

// Harness files (written on every run, full or --minimal).
const CLAUDE = '.claude/settings.json'
const CODEX = '.codex/hooks.json'
const AGENTS_HOOKS = '.agents/hooks.json'
const AGENTS_MD = 'AGENTS.md'
const CLAUDE_MD = 'CLAUDE.md'
const LEFTHOOK_YML = 'lefthook.yml'

// App files (written on a full run only).
const BIOME = 'biome.json'
const OXLINT = '.oxlintrc.json'
const APP_TS = 'src/app.ts'
const CONTEXT_TS = 'src/context.ts'
const MAIN_TS = 'src/main.ts'
const MIDDLEWARE = 'src/middlewares/request-logger.ts'
const HEALTH_ROUTE = 'src/modules/health/health.route.ts'
const HEALTH_TEST = 'src/modules/health/health.test.ts'
const HEALTH_HURL = 'src/modules/health/health.hurl'
const GREETINGS_ROUTE = 'src/modules/greetings/greetings.route.ts'
const GREETINGS_HURL = 'src/modules/greetings/greetings.hurl'
const PACKAGE_JSON = 'package.json'
const TSCONFIG_JSON = 'tsconfig.json'
const GITIGNORE = '.gitignore'
const README = 'README.md'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kata-init-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function statusOf(result: InitResult, path: string): FileStatus | undefined {
  return result.files.find((file) => file.path === path)?.status
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Write a pre-existing file (creating parents) to simulate a project that
 *  already has one of the generated files. */
async function seed(relPath: string, content: string): Promise<void> {
  const absolute = join(dir, relPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

describe('init() — full project scaffold (issue #200)', () => {
  it('writes the harness configs, including the vendor-neutral .agents mirror', async () => {
    const result = await init({ cwd: dir })

    const paths = [CLAUDE, CODEX, AGENTS_HOOKS, AGENTS_MD, CLAUDE_MD, LEFTHOOK_YML]
    for (const path of paths) expect(statusOf(result, path)).toBe('created')
    const present = await Promise.all(paths.map((p) => exists(join(dir, p))))
    expect(present).toEqual(paths.map(() => true))
  })

  it('writes the full canonical app: app.ts, context, middleware, both modules', async () => {
    const result = await init({ cwd: dir })

    const paths = [
      APP_TS,
      CONTEXT_TS,
      MAIN_TS,
      MIDDLEWARE,
      HEALTH_ROUTE,
      HEALTH_TEST,
      HEALTH_HURL,
      GREETINGS_ROUTE,
      GREETINGS_HURL,
    ]
    for (const path of paths) expect(statusOf(result, path)).toBe('created')
    const present = await Promise.all(paths.map((p) => exists(join(dir, p))))
    expect(present).toEqual(paths.map(() => true))
  })

  it('writes the manifests + lint configs so the app boots and the harness runs', async () => {
    const result = await init({ cwd: dir })

    for (const path of [PACKAGE_JSON, TSCONFIG_JSON, BIOME, OXLINT, GITIGNORE, README]) {
      expect(statusOf(result, path)).toBe('created')
    }
  })

  it('writes exactly what the generators render', async () => {
    const result = await init({ cwd: dir })

    expect(await readFile(join(dir, CLAUDE), 'utf8')).toBe(renderClaudeSettings())
    expect(await readFile(join(dir, AGENTS_HOOKS), 'utf8')).toBe(renderAgentsHooks())
    expect(await readFile(join(dir, APP_TS), 'utf8')).toBe(renderExampleApp())
    // package.json is titled after the (resolved) target directory.
    expect(await readFile(join(dir, PACKAGE_JSON), 'utf8')).toBe(
      renderExamplePackageJson(appNameFromDir(result.cwd)),
    )
  })

  it('creates the harness parent directories', async () => {
    await init({ cwd: dir })

    const subs = ['.claude', '.codex', '.agents', 'src/modules/greetings']
    const present = await Promise.all(subs.map((s) => exists(join(dir, s))))
    expect(present).toEqual(subs.map(() => true))
  })

  it('reports an absolute project root and the minimal flag', async () => {
    const result = await init({ cwd: dir })
    expect(isAbsolute(result.cwd)).toBe(true)
    expect(result.minimal).toBe(false)
  })

  it('is idempotent: a second run skips everything', async () => {
    await init({ cwd: dir })
    const second = await init({ cwd: dir })

    for (const path of [CLAUDE, APP_TS, PACKAGE_JSON, GREETINGS_ROUTE]) {
      expect(statusOf(second, path)).toBe('skipped')
    }
  })
})

describe('init({ dir }) — positional target directory', () => {
  it('scaffolds into a subdirectory resolved against cwd and reports the label', async () => {
    const result = await init({ cwd: dir, dir: 'my-app' })

    expect(result.dir).toBe('my-app')
    expect(result.cwd).toBe(join(dir, 'my-app'))
    expect(await exists(join(dir, 'my-app', APP_TS))).toBe(true)
    expect(await exists(join(dir, 'my-app', PACKAGE_JSON))).toBe(true)
    // Nothing leaks into the parent.
    expect(await exists(join(dir, APP_TS))).toBe(false)
  })

  it('defaults the dir label to "." when scaffolding in place', async () => {
    const result = await init({ cwd: dir })
    expect(result.dir).toBe('.')
  })
})

describe('init({ minimal: true }) — harness only', () => {
  it('writes the harness files and nothing else', async () => {
    const result = await init({ cwd: dir, minimal: true })

    expect(statusOf(result, CLAUDE)).toBe('created')
    expect(statusOf(result, AGENTS_HOOKS)).toBe('created')
    expect(result.minimal).toBe(true)
    // No app, no manifests.
    expect(statusOf(result, APP_TS)).toBeUndefined()
    expect(statusOf(result, PACKAGE_JSON)).toBeUndefined()
    expect(statusOf(result, BIOME)).toBeUndefined()
    expect(await exists(join(dir, MAIN_TS))).toBe(false)
    expect(await exists(join(dir, PACKAGE_JSON))).toBe(false)
  })
})

describe('init() — overwrite / idempotency rules', () => {
  it('skips existing files instead of clobbering them', async () => {
    await seed(MAIN_TS, 'OLD')

    const result = await init({ cwd: dir })

    expect(statusOf(result, MAIN_TS)).toBe('skipped')
    expect(await readFile(join(dir, MAIN_TS), 'utf8')).toBe('OLD')
    expect(statusOf(result, APP_TS)).toBe('created')
  })

  it('overwrites an existing source file under --force', async () => {
    await seed(MAIN_TS, 'OLD')

    const result = await init({ cwd: dir, force: true })

    expect(statusOf(result, MAIN_TS)).toBe('overwritten')
    expect(await readFile(join(dir, MAIN_TS), 'utf8')).not.toBe('OLD')
  })

  it('never clobbers the manifests/configs — even with --force (only-if-absent)', async () => {
    await seed(PACKAGE_JSON, '{ "name": "mine" }')
    await seed(TSCONFIG_JSON, 'KEEP-TS')
    await seed(BIOME, 'KEEP-BIOME')
    await seed(OXLINT, 'KEEP-OX')
    await seed(GITIGNORE, 'KEEP-IGNORE')
    await seed(README, 'KEEP-README')

    const result = await init({ cwd: dir, force: true })

    const cases = [
      [PACKAGE_JSON, '{ "name": "mine" }'],
      [TSCONFIG_JSON, 'KEEP-TS'],
      [BIOME, 'KEEP-BIOME'],
      [OXLINT, 'KEEP-OX'],
      [GITIGNORE, 'KEEP-IGNORE'],
      [README, 'KEEP-README'],
    ] as const
    for (const [path] of cases) expect(statusOf(result, path)).toBe('skipped')
    const contents = await Promise.all(cases.map(([path]) => readFile(join(dir, path), 'utf8')))
    expect(contents).toEqual(cases.map(([, content]) => content))
  })
})

describe('appNameFromDir()', () => {
  it('uses the directory basename, lowercased and npm-sanitised', () => {
    expect(appNameFromDir('/home/me/My App')).toBe('my-app')
    expect(appNameFromDir('/srv/orders-api')).toBe('orders-api')
  })

  it('falls back to kata-app when the basename yields nothing usable', () => {
    expect(appNameFromDir('/')).toBe('kata-app')
  })
})
