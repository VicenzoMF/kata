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
import type { ClaudeSettings, CodexHooks } from './templates/types'

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
const ENV_EXAMPLE = '.env.example'
const README = 'README.md'
const ADR_TEMPLATE = 'docs/adr/_template.md'
const ADR_README = 'docs/adr/README.md'

// Opt-in file (--with-docs-mcp only).
const MCP_JSON = '.mcp.json'

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

  it('writes exactly the file list documented in docs/guide/cli.md (issue #242)', async () => {
    // Guard against doc drift: if a target is added, removed, or reordered in
    // `harnessTargets`/`appTargets` (init.ts), this fails until the `kata init`
    // output block in docs/guide/cli.md (and its docs/pt/guide/cli.md mirror)
    // is updated to match.
    const result = await init({ cwd: dir })

    expect(result.files.map((file) => file.path)).toEqual([
      CLAUDE,
      CODEX,
      AGENTS_HOOKS,
      AGENTS_MD,
      CLAUDE_MD,
      LEFTHOOK_YML,
      BIOME,
      OXLINT,
      CONTEXT_TS,
      APP_TS,
      MAIN_TS,
      MIDDLEWARE,
      'src/modules/health/health.schema.ts',
      'src/modules/health/health.service.ts',
      HEALTH_ROUTE,
      HEALTH_TEST,
      HEALTH_HURL,
      'src/modules/greetings/greetings.schema.ts',
      'src/modules/greetings/greetings.service.ts',
      GREETINGS_ROUTE,
      'src/modules/greetings/greetings.test.ts',
      GREETINGS_HURL,
      PACKAGE_JSON,
      TSCONFIG_JSON,
      GITIGNORE,
      ENV_EXAMPLE,
      README,
      ADR_TEMPLATE,
      ADR_README,
    ])
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

  it('writes .env.example and the app-local ADR scaffold (issue #213)', async () => {
    const result = await init({ cwd: dir })

    for (const path of [ENV_EXAMPLE, ADR_TEMPLATE, ADR_README]) {
      expect(statusOf(result, path)).toBe('created')
    }
    expect(await readFile(join(dir, ENV_EXAMPLE), 'utf8')).toContain('JWT_SECRET=')
    expect(await readFile(join(dir, ADR_README), 'utf8')).toMatch(
      /github\.com\/VicenzoMF\/kata\/tree\/katajs-v\d+\.\d+\.\d+\/docs\/adr/,
    )
  })

  it('writes exactly what the generators render', async () => {
    const result = await init({ cwd: dir })

    expect(await readFile(join(dir, CLAUDE), 'utf8')).toBe(
      renderClaudeSettings(result.packageManager),
    )
    expect(await readFile(join(dir, AGENTS_HOOKS), 'utf8')).toBe(
      renderAgentsHooks(result.packageManager),
    )
    expect(await readFile(join(dir, APP_TS), 'utf8')).toBe(renderExampleApp())
    // package.json is titled after the (resolved) target directory.
    expect(await readFile(join(dir, PACKAGE_JSON), 'utf8')).toBe(
      renderExamplePackageJson(appNameFromDir(result.cwd)),
    )
  })

  it('creates the harness parent directories', async () => {
    await init({ cwd: dir })

    const subs = ['.claude', '.codex', '.agents', 'src/modules/greetings', 'docs/adr']
    const present = await Promise.all(subs.map((s) => exists(join(dir, s))))
    expect(present).toEqual(subs.map(() => true))
  })

  it('reports an absolute project root and the minimal flag', async () => {
    const result = await init({ cwd: dir })
    expect(isAbsolute(result.cwd)).toBe(true)
    expect(result.minimal).toBe(false)
  })

  it('reports the package manager detected from env (issue #214)', async () => {
    const npm = await init({ cwd: dir, env: { npm_config_user_agent: 'npm/10.2.0 node/v20' } })
    expect(npm.packageManager).toBe('npm')

    const pnpm = await init({
      cwd: dir,
      force: true,
      env: { npm_config_user_agent: 'pnpm/8.6.0 npm/? node/v20' },
    })
    expect(pnpm.packageManager).toBe('pnpm')
  })

  it('is idempotent: a second run skips everything', async () => {
    await init({ cwd: dir })
    const second = await init({ cwd: dir })

    for (const path of [CLAUDE, APP_TS, PACKAGE_JSON, GREETINGS_ROUTE, ENV_EXAMPLE, ADR_README]) {
      expect(statusOf(second, path)).toBe('skipped')
    }
  })
})

describe('generated harness hooks resolve the detected package manager (issue #231)', () => {
  it('npm scaffold: hooks call `npx kata verify` / `npm run test`, never a bare `kata` or `pnpm`', async () => {
    const result = await init({ cwd: dir, env: { npm_config_user_agent: 'npm/10.2.0 node/v20' } })
    expect(result.packageManager).toBe('npm')

    const claude = JSON.parse(await readFile(join(dir, CLAUDE), 'utf8')) as ClaudeSettings
    expect(claude.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('npx kata verify --json')
    expect(claude.hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('npx kata verify --json')
    expect(claude.hooks.Stop?.[0]?.hooks[0]?.command).toBe('npx kata verify && npm run test')

    const codex = JSON.parse(await readFile(join(dir, CODEX), 'utf8')) as CodexHooks
    expect(codex.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('npx kata verify --json')
    expect(codex.hooks.Stop?.[0]?.hooks[0]?.command).toBe('npx kata verify && npm run test')

    const agents = JSON.parse(await readFile(join(dir, AGENTS_HOOKS), 'utf8')) as CodexHooks
    expect(agents.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('npx kata verify --json')
    expect(agents.hooks.Stop?.[0]?.hooks[0]?.command).toBe('npx kata verify && npm run test')
  })

  it('pnpm scaffold: hooks call `pnpm exec kata verify` / `pnpm test`', async () => {
    const result = await init({
      cwd: dir,
      env: { npm_config_user_agent: 'pnpm/8.6.0 npm/? node/v20' },
    })
    expect(result.packageManager).toBe('pnpm')

    const claude = JSON.parse(await readFile(join(dir, CLAUDE), 'utf8')) as ClaudeSettings
    expect(claude.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('pnpm exec kata verify --json')
    expect(claude.hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('pnpm exec kata verify --json')
    expect(claude.hooks.Stop?.[0]?.hooks[0]?.command).toBe('pnpm exec kata verify && pnpm test')

    const codex = JSON.parse(await readFile(join(dir, CODEX), 'utf8')) as CodexHooks
    expect(codex.hooks.Stop?.[0]?.hooks[0]?.command).toBe('pnpm exec kata verify && pnpm test')

    const agents = JSON.parse(await readFile(join(dir, AGENTS_HOOKS), 'utf8')) as CodexHooks
    expect(agents.hooks.Stop?.[0]?.hooks[0]?.command).toBe('pnpm exec kata verify && pnpm test')
  })

  it('yarn scaffold: hooks call `yarn kata verify` / `yarn test`', async () => {
    const result = await init({
      cwd: dir,
      env: { npm_config_user_agent: 'yarn/1.22.19 npm/? node/v20' },
    })
    expect(result.packageManager).toBe('yarn')

    const claude = JSON.parse(await readFile(join(dir, CLAUDE), 'utf8')) as ClaudeSettings
    expect(claude.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('yarn kata verify --json')
    expect(claude.hooks.Stop?.[0]?.hooks[0]?.command).toBe('yarn kata verify && yarn test')
  })

  it('bun scaffold: hooks call `bunx kata verify` / `bun run test`', async () => {
    const result = await init({ cwd: dir, env: { npm_config_user_agent: 'bun/1.1.0 node/v20' } })
    expect(result.packageManager).toBe('bun')

    const claude = JSON.parse(await readFile(join(dir, CLAUDE), 'utf8')) as ClaudeSettings
    expect(claude.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('bunx kata verify --json')
    expect(claude.hooks.Stop?.[0]?.hooks[0]?.command).toBe('bunx kata verify && bun run test')
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
    expect(statusOf(result, ADR_README)).toBeUndefined()
    expect(await exists(join(dir, MAIN_TS))).toBe(false)
    expect(await exists(join(dir, PACKAGE_JSON))).toBe(false)
    expect(await exists(join(dir, ADR_README))).toBe(false)
  })
})

describe('init({ docsMcp: true }) — .mcp.json opt-in', () => {
  it('writes .mcp.json registering @katajs-framework/docs-mcp via npx', async () => {
    const result = await init({ cwd: dir, docsMcp: true })

    expect(result.docsMcp).toBe(true)
    expect(statusOf(result, MCP_JSON)).toBe('created')
    const content = JSON.parse(await readFile(join(dir, MCP_JSON), 'utf8'))
    expect(content.mcpServers['kata-docs'].command).toBe('npx')
    expect(content.mcpServers['kata-docs'].args).toContain('@katajs-framework/docs-mcp')
  })

  it('does not write .mcp.json when the flag is omitted', async () => {
    const result = await init({ cwd: dir })

    expect(result.docsMcp).toBe(false)
    expect(statusOf(result, MCP_JSON)).toBeUndefined()
    expect(await exists(join(dir, MCP_JSON))).toBe(false)
  })

  it('never overwrites an existing .mcp.json (onlyIfAbsent)', async () => {
    await seed(MCP_JSON, '{"mcpServers":{"other":{"command":"whatever"}}}')

    const result = await init({ cwd: dir, docsMcp: true, force: true })

    expect(statusOf(result, MCP_JSON)).toBe('skipped')
    const content = await readFile(join(dir, MCP_JSON), 'utf8')
    expect(content).toContain('other')
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
    await seed(ENV_EXAMPLE, 'KEEP-ENV')
    await seed(ADR_TEMPLATE, 'KEEP-ADR-TEMPLATE')
    await seed(ADR_README, 'KEEP-ADR-README')

    const result = await init({ cwd: dir, force: true })

    const cases = [
      [PACKAGE_JSON, '{ "name": "mine" }'],
      [TSCONFIG_JSON, 'KEEP-TS'],
      [BIOME, 'KEEP-BIOME'],
      [OXLINT, 'KEEP-OX'],
      [GITIGNORE, 'KEEP-IGNORE'],
      [README, 'KEEP-README'],
      [ENV_EXAMPLE, 'KEEP-ENV'],
      [ADR_TEMPLATE, 'KEEP-ADR-TEMPLATE'],
      [ADR_README, 'KEEP-ADR-README'],
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
