import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectPackageManager, pmCommands } from './package-manager'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kata-pm-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('detectPackageManager()', () => {
  it('reads the invoking tool off npm_config_user_agent first', () => {
    expect(detectPackageManager(dir, { npm_config_user_agent: 'pnpm/8.6.0 npm/? node/v20' })).toBe(
      'pnpm',
    )
    expect(
      detectPackageManager(dir, { npm_config_user_agent: 'yarn/1.22.19 npm/? node/v20' }),
    ).toBe('yarn')
    expect(detectPackageManager(dir, { npm_config_user_agent: 'bun/1.1.0' })).toBe('bun')
    expect(detectPackageManager(dir, { npm_config_user_agent: 'npm/10.2.0 node/v20' })).toBe('npm')
  })

  it('falls back to the lockfile already in the target directory', async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(dir, {})).toBe('pnpm')
  })

  it('falls back to npm when there is no user agent and no lockfile', () => {
    expect(detectPackageManager(dir, {})).toBe('npm')
  })

  it('prefers the user agent over a lockfile that disagrees', async () => {
    await writeFile(join(dir, 'package-lock.json'), '')
    expect(detectPackageManager(dir, { npm_config_user_agent: 'pnpm/8.6.0' })).toBe('pnpm')
  })
})

describe('pmCommands()', () => {
  it("spells install/run/exec in each package manager's own syntax", () => {
    expect(pmCommands('npm').install).toBe('npm install')
    expect(pmCommands('npm').run('dev')).toBe('npm run dev')
    expect(pmCommands('npm').exec('kata verify')).toBe('npx kata verify')

    expect(pmCommands('pnpm').install).toBe('pnpm install')
    expect(pmCommands('pnpm').run('dev')).toBe('pnpm dev')
    expect(pmCommands('pnpm').exec('kata verify')).toBe('pnpm exec kata verify')

    expect(pmCommands('yarn').install).toBe('yarn install')
    expect(pmCommands('yarn').run('dev')).toBe('yarn dev')
    expect(pmCommands('yarn').exec('kata verify')).toBe('yarn kata verify')

    expect(pmCommands('bun').install).toBe('bun install')
    expect(pmCommands('bun').run('dev')).toBe('bun run dev')
    expect(pmCommands('bun').exec('kata verify')).toBe('bunx kata verify')
  })
})
