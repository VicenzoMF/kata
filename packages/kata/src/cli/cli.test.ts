import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatResult, parseArgs, run } from './cli'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kata-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('parseArgs()', () => {
  it('reads the command', () => {
    expect(parseArgs(['init'])).toEqual({
      command: 'init',
      cwd: undefined,
      force: false,
      help: false,
    })
  })

  it('parses --force and -f', () => {
    expect(parseArgs(['init', '--force']).force).toBe(true)
    expect(parseArgs(['init', '-f']).force).toBe(true)
  })

  it('parses --cwd <dir>, --cwd=<dir>, and -C <dir>', () => {
    expect(parseArgs(['init', '--cwd', '/tmp/x']).cwd).toBe('/tmp/x')
    expect(parseArgs(['init', '--cwd=/tmp/y']).cwd).toBe('/tmp/y')
    expect(parseArgs(['init', '-C', '/tmp/z']).cwd).toBe('/tmp/z')
  })

  it('parses --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('keeps the first positional as the command, ignoring later ones', () => {
    expect(parseArgs(['init', 'extra']).command).toBe('init')
  })
})

describe('run()', () => {
  it('prints help and exits 0 on --help', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stderr).toBe('')
  })

  it('errors on a missing command', async () => {
    const result = await run([])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('missing command')
  })

  it('errors on an unknown command', async () => {
    const result = await run(['frobnicate'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("unknown command 'frobnicate'")
  })

  it('runs init into the given --cwd and reports the files', async () => {
    const result = await run(['init', '--cwd', dir])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('.claude/settings.json')
    expect(result.stdout).toContain('.codex/hooks.json')
    expect(result.stdout).toContain('AGENTS.md')
    expect(result.stdout).toContain('CLAUDE.md')
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true)
    expect(await exists(join(dir, '.codex/hooks.json'))).toBe(true)
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(true)
    expect(await exists(join(dir, 'CLAUDE.md'))).toBe(true)
  })

  it('reports skips on a second run', async () => {
    await run(['init', '--cwd', dir])
    const second = await run(['init', '--cwd', dir])

    expect(second.code).toBe(0)
    expect(second.stdout).toContain('skip')
    expect(second.stdout).toContain('--force')
  })
})

describe('formatResult()', () => {
  it('lists each file with its status mark', () => {
    const text = formatResult({
      cwd: '/proj',
      files: [
        { path: '.claude/settings.json', status: 'created' },
        { path: '.codex/hooks.json', status: 'skipped' },
      ],
    })
    expect(text).toContain('/proj')
    expect(text).toContain('create  .claude/settings.json')
    expect(text).toContain('skip  .codex/hooks.json')
    expect(text).toContain('--force')
  })
})
