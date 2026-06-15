import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
import { type FileStatus, type InitResult, init } from './init'

const CLAUDE = '.claude/settings.json'
const CODEX = '.codex/hooks.json'
const AGENTS_MD = 'AGENTS.md'
const CLAUDE_MD = 'CLAUDE.md'

const CONTEXT_TS = 'src/context.ts'
const MAIN_TS = 'src/main.ts'
const HEALTH_ROUTE = 'src/modules/health/health.route.ts'
const HEALTH_SCHEMA = 'src/modules/health/health.schema.ts'
const PACKAGE_JSON = 'package.json'
const TSCONFIG_JSON = 'tsconfig.json'

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
 *  already has one of the harness configs. */
async function seed(relPath: string, content: string): Promise<void> {
  const absolute = join(dir, relPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

describe('init()', () => {
  it('creates both harness config files', async () => {
    const result = await init({ cwd: dir })

    expect(statusOf(result, CLAUDE)).toBe('created')
    expect(statusOf(result, CODEX)).toBe('created')
    expect(await exists(join(dir, CLAUDE))).toBe(true)
    expect(await exists(join(dir, CODEX))).toBe(true)
  })

  it('creates the AGENTS.md / CLAUDE.md instruction pair (#31)', async () => {
    const result = await init({ cwd: dir })

    expect(statusOf(result, AGENTS_MD)).toBe('created')
    expect(statusOf(result, CLAUDE_MD)).toBe('created')
    expect(await exists(join(dir, AGENTS_MD))).toBe(true)
    expect(await readFile(join(dir, CLAUDE_MD), 'utf8')).toContain('@AGENTS.md')
  })

  it('writes exactly what the generators render', async () => {
    await init({ cwd: dir })

    expect(await readFile(join(dir, CLAUDE), 'utf8')).toBe(renderClaudeSettings())
    expect(await readFile(join(dir, CODEX), 'utf8')).toBe(renderCodexHooks())
    expect(await readFile(join(dir, AGENTS_MD), 'utf8')).toBe(renderAgentsMd())
    expect(await readFile(join(dir, CLAUDE_MD), 'utf8')).toBe(renderClaudeMd())
  })

  it('creates the .claude and .codex parent directories', async () => {
    await init({ cwd: dir })

    expect(await exists(join(dir, '.claude'))).toBe(true)
    expect(await exists(join(dir, '.codex'))).toBe(true)
  })

  it('reports an absolute project root', async () => {
    const result = await init({ cwd: dir })
    expect(isAbsolute(result.cwd)).toBe(true)
  })

  it('skips existing files instead of clobbering them', async () => {
    await seed(CODEX, 'SENTINEL')

    const result = await init({ cwd: dir })

    expect(statusOf(result, CODEX)).toBe('skipped')
    expect(await readFile(join(dir, CODEX), 'utf8')).toBe('SENTINEL')
    // The file that did not pre-exist is still created.
    expect(statusOf(result, CLAUDE)).toBe('created')
  })

  it('overwrites existing files when force is set', async () => {
    await seed(CODEX, 'SENTINEL')

    const result = await init({ cwd: dir, force: true })

    expect(statusOf(result, CODEX)).toBe('overwritten')
    expect(await readFile(join(dir, CODEX), 'utf8')).toBe(renderCodexHooks())
  })

  it('is idempotent: a second run skips everything', async () => {
    await init({ cwd: dir })
    const second = await init({ cwd: dir })

    expect(statusOf(second, CLAUDE)).toBe('skipped')
    expect(statusOf(second, CODEX)).toBe('skipped')
    expect(statusOf(second, AGENTS_MD)).toBe('skipped')
    expect(statusOf(second, CLAUDE_MD)).toBe('skipped')
  })
})

describe('init({ withExample: true }) — ADR-0015 D1', () => {
  it('scaffolds the four example source files', async () => {
    const result = await init({ cwd: dir, withExample: true })

    expect(statusOf(result, CONTEXT_TS)).toBe('created')
    expect(statusOf(result, MAIN_TS)).toBe('created')
    expect(statusOf(result, HEALTH_ROUTE)).toBe('created')
    expect(statusOf(result, HEALTH_SCHEMA)).toBe('created')
    expect(await exists(join(dir, MAIN_TS))).toBe(true)
    expect(await exists(join(dir, HEALTH_ROUTE))).toBe(true)
  })

  it('also emits package.json and tsconfig.json so the app boots', async () => {
    const result = await init({ cwd: dir, withExample: true })

    expect(statusOf(result, PACKAGE_JSON)).toBe('created')
    expect(statusOf(result, TSCONFIG_JSON)).toBe('created')
  })

  it('writes exactly what the example generators render', async () => {
    await init({ cwd: dir, withExample: true })

    expect(await readFile(join(dir, CONTEXT_TS), 'utf8')).toBe(renderExampleContext())
    expect(await readFile(join(dir, MAIN_TS), 'utf8')).toBe(renderExampleMain())
    expect(await readFile(join(dir, HEALTH_ROUTE), 'utf8')).toBe(renderExampleHealthRoute())
    expect(await readFile(join(dir, HEALTH_SCHEMA), 'utf8')).toBe(renderExampleHealthSchema())
    expect(await readFile(join(dir, PACKAGE_JSON), 'utf8')).toBe(renderExamplePackageJson())
    expect(await readFile(join(dir, TSCONFIG_JSON), 'utf8')).toBe(renderExampleTsconfig())
  })

  it('still writes the harness files (the example rides on top)', async () => {
    const result = await init({ cwd: dir, withExample: true })

    expect(statusOf(result, CLAUDE)).toBe('created')
    expect(statusOf(result, AGENTS_MD)).toBe('created')
  })

  it('writes no example files without the flag', async () => {
    const result = await init({ cwd: dir })

    expect(statusOf(result, MAIN_TS)).toBeUndefined()
    expect(statusOf(result, PACKAGE_JSON)).toBeUndefined()
    expect(await exists(join(dir, MAIN_TS))).toBe(false)
  })

  it('overwrites an existing source file under --force', async () => {
    await seed(MAIN_TS, 'OLD')

    const result = await init({ cwd: dir, withExample: true, force: true })

    expect(statusOf(result, MAIN_TS)).toBe('overwritten')
    expect(await readFile(join(dir, MAIN_TS), 'utf8')).toBe(renderExampleMain())
  })

  it('never clobbers an existing package.json — even with --force (only-if-absent)', async () => {
    await seed(PACKAGE_JSON, '{ "name": "mine" }')

    const result = await init({ cwd: dir, withExample: true, force: true })

    expect(statusOf(result, PACKAGE_JSON)).toBe('skipped')
    expect(await readFile(join(dir, PACKAGE_JSON), 'utf8')).toBe('{ "name": "mine" }')
  })

  it('never clobbers an existing tsconfig.json — even with --force (only-if-absent)', async () => {
    await seed(TSCONFIG_JSON, 'KEEP')

    const result = await init({ cwd: dir, withExample: true, force: true })

    expect(statusOf(result, TSCONFIG_JSON)).toBe('skipped')
    expect(await readFile(join(dir, TSCONFIG_JSON), 'utf8')).toBe('KEEP')
  })
})
