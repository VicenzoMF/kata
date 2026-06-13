import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderClaudeSettings, renderCodexHooks } from './generators'
import { type FileStatus, type InitResult, init } from './init'

const CLAUDE = '.claude/settings.json'
const CODEX = '.codex/hooks.json'

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

  it('writes exactly what the generators render', async () => {
    await init({ cwd: dir })

    expect(await readFile(join(dir, CLAUDE), 'utf8')).toBe(renderClaudeSettings())
    expect(await readFile(join(dir, CODEX), 'utf8')).toBe(renderCodexHooks())
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
  })
})
