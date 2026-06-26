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
  it('reads the command with full defaults', () => {
    expect(parseArgs(['init'])).toEqual({
      command: 'init',
      domain: undefined,
      dir: undefined,
      cwd: undefined,
      force: false,
      help: false,
      minimal: false,
    })
  })

  it('reads the [dir] positional for init', () => {
    expect(parseArgs(['init', 'my-app']).dir).toBe('my-app')
  })

  it('parses --minimal', () => {
    expect(parseArgs(['init', '--minimal']).minimal).toBe(true)
    expect(parseArgs(['init']).minimal).toBe(false)
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

  it('throws when --cwd is missing a value', () => {
    expect(() => parseArgs(['init', '--cwd'])).toThrow('kata: --cwd requires a directory value')
    expect(() => parseArgs(['init', '-C', '--force'])).toThrow(
      'kata: --cwd requires a directory value',
    )
  })

  it('parses new command with domain', () => {
    const args = parseArgs(['new', 'ping'])
    expect(args.command).toBe('new')
    expect(args.domain).toBe('ping')
  })

  it('tolerates unknown flags instead of erroring (e.g. the old --with-example)', () => {
    const args = parseArgs(['init', '--with-example', 'my-app'])
    expect(args.command).toBe('init')
    expect(args.dir).toBe('my-app')
  })
})

describe('run() — init', () => {
  it('prints help and exits 0 on --help', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stderr).toBe('')
  })

  it('errors on a missing command', async () => {
    const result = await run([])
    expect(result.code).toBe(1)
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
    expect(result.stderr).toContain('kata: --cwd requires a directory value')
  })

  it('scaffolds the full app (harness + src + manifests) and prints next steps', async () => {
    const result = await run(['init', '--cwd', dir])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('.claude/settings.json')
    expect(result.stdout).toContain('.agents/hooks.json')
    expect(result.stdout).toContain('src/app.ts')
    expect(result.stdout).toContain('src/modules/greetings/greetings.route.ts')
    expect(result.stdout).toContain('package.json')
    expect(result.stdout).toContain('Next steps:')
    expect(result.stdout).toContain('pnpm install')
    expect(await exists(join(dir, 'src/app.ts'))).toBe(true)
    expect(await exists(join(dir, 'src/modules/health/health.route.ts'))).toBe(true)
    expect(await exists(join(dir, 'package.json'))).toBe(true)
  })

  it('honours the [dir] positional, resolved against --cwd', async () => {
    const result = await run(['init', 'app', '--cwd', dir])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('cd app')
    expect(await exists(join(dir, 'app/src/app.ts'))).toBe(true)
  })

  it('writes harness only with --minimal', async () => {
    const result = await run(['init', '--minimal', '--cwd', dir])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('.claude/settings.json')
    expect(result.stdout).toContain('Harness configs written')
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true)
    expect(await exists(join(dir, 'src/app.ts'))).toBe(false)
    expect(await exists(join(dir, 'package.json'))).toBe(false)
  })

  it('reports skips on a second run', async () => {
    await run(['init', '--cwd', dir])
    const second = await run(['init', '--cwd', dir])

    expect(second.code).toBe(0)
    expect(second.stdout).toContain('skip')
    expect(second.stdout).toContain('--force')
  })
})

describe('run() — new', () => {
  it('errors on missing domain', async () => {
    const result = await run(['new'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('missing domain name')
  })

  it('generates the five-file module skeleton', async () => {
    const result = await run(['new', 'ping', '--cwd', dir])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('ping.route.ts')
    expect(result.stdout).toContain('ping.service.ts')
    expect(result.stdout).toContain('ping.schema.ts')
    expect(result.stdout).toContain('ping.test.ts')
    expect(result.stdout).toContain('ping.hurl')
    expect(await exists(join(dir, 'src/modules/ping/ping.route.ts'))).toBe(true)
  })
})

describe('run() — verify', () => {
  it('dispatches `verify` to the rule engine, not the unknown-command path', async () => {
    const result = await run(['verify', '--help'], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('kata verify')
    expect(result.stderr).toBe('')
  })

  it('verifies the scaffolded app clean (exit 0)', async () => {
    await run(['init', '--cwd', dir])
    const result = await run(['verify', dir], dir)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no problems found')
  })

  it('emits PostToolUse hook JSON in --json mode and always exits 0', async () => {
    await run(['init', '--cwd', dir])
    const result = await run(['verify', dir, '--json'], dir)
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.decision).toBeUndefined() // clean run → no block decision
  })
})

describe('formatResult()', () => {
  it('lists each file with its status mark and the next steps', () => {
    const text = formatResult({
      cwd: '/proj/my-app',
      dir: 'my-app',
      minimal: false,
      files: [
        { path: '.claude/settings.json', status: 'created' },
        { path: 'package.json', status: 'skipped' },
      ],
    })
    expect(text).toContain('/proj/my-app')
    expect(text).toContain('create  .claude/settings.json')
    expect(text).toContain('skip  package.json')
    expect(text).toContain('cd my-app')
    expect(text).toContain('pnpm install')
  })

  it('prints the harness-only guidance for a minimal run', () => {
    const text = formatResult({
      cwd: '/proj',
      dir: '.',
      minimal: true,
      files: [{ path: '.claude/settings.json', status: 'created' }],
    })
    expect(text).toContain('Harness configs written')
    expect(text).not.toContain('pnpm install')
  })
})
