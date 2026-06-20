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
      withExample: false,
    })
  })

  it('parses --force and -f', () => {
    expect(parseArgs(['init', '--force']).force).toBe(true)
    expect(parseArgs(['init', '-f']).force).toBe(true)
  })

  it('parses --with-example (defaulting to false)', () => {
    expect(parseArgs(['init', '--with-example']).withExample).toBe(true)
    expect(parseArgs(['init']).withExample).toBe(false)
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

  it('throws when --cwd is missing a value', () => {
    expect(() => parseArgs(['init', '--cwd'])).toThrow('kata: --cwd requires a directory value')
    expect(() => parseArgs(['init', '-C', '--force'])).toThrow(
      'kata: --cwd requires a directory value',
    )
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

  it('errors when --cwd is missing a value', async () => {
    const result = await run(['init', '--cwd'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('kata: --cwd requires a directory value')
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

  it('scaffolds the runnable example app with --with-example', async () => {
    const result = await run(['init', '--with-example', '--cwd', dir])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('src/context.ts')
    expect(result.stdout).toContain('src/main.ts')
    expect(result.stdout).toContain('src/modules/health/health.route.ts')
    expect(result.stdout).toContain('src/modules/health/health.schema.ts')
    expect(result.stdout).toContain('package.json')
    expect(result.stdout).toContain('tsconfig.json')
    expect(await exists(join(dir, 'src/main.ts'))).toBe(true)
    expect(await exists(join(dir, 'src/modules/health/health.route.ts'))).toBe(true)
    expect(await exists(join(dir, 'package.json'))).toBe(true)
    expect(await exists(join(dir, 'tsconfig.json'))).toBe(true)
    // The harness files are still written alongside the example.
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true)
  })

  it('stays harness-only without the flag (the flag is purely additive)', async () => {
    await run(['init', '--cwd', dir])

    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true)
    expect(await exists(join(dir, 'src/main.ts'))).toBe(false)
    expect(await exists(join(dir, 'package.json'))).toBe(false)
    expect(await exists(join(dir, 'tsconfig.json'))).toBe(false)
  })
})

describe('run() — verify', () => {
  it('dispatches `verify` to the rule engine, not the unknown-command path', async () => {
    const result = await run(['verify', '--help'], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('kata verify')
    expect(result.stderr).toBe('')
  })

  it('verifies the scaffolded example app clean (exit 0)', async () => {
    await run(['init', '--with-example', '--cwd', dir])
    const result = await run(['verify', dir], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no problems found')
  })

  it('emits PostToolUse hook JSON in --json mode and always exits 0', async () => {
    await run(['init', '--with-example', '--cwd', dir])
    const result = await run(['verify', dir, '--json'], dir)
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.decision).toBeUndefined() // clean run → no block decision
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
