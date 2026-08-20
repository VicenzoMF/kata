import { describe, expect, it } from 'vitest'

import {
  renderAgentsHooks,
  renderAgentsMd,
  renderBiomeJson,
  renderClaudeMd,
  renderClaudeSettings,
  renderCodexHooks,
  renderExampleAdrReadme,
  renderExampleAdrTemplate,
  renderExampleApp,
  renderExampleContext,
  renderExampleEnvExample,
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
  renderMcpJson,
  renderModuleHurl,
  renderModuleRoute,
  renderModuleSchema,
  renderModuleService,
  renderModuleTest,
  renderOxlintrc,
  serialize,
} from './generators'
import type { ClaudeSettings, CodexHooks } from './templates/types'
import { KATA_VERSION } from './templates/version'

function parseClaude(): ClaudeSettings {
  return JSON.parse(renderClaudeSettings()) as ClaudeSettings
}

function parseCodex(): CodexHooks {
  return JSON.parse(renderCodexHooks()) as CodexHooks
}

function parseAgents(): CodexHooks {
  return JSON.parse(renderAgentsHooks()) as CodexHooks
}

describe('serialize()', () => {
  it('emits 2-space-indented JSON with a trailing newline', () => {
    const out = serialize({ a: 1, b: { c: 2 } })
    expect(out).toBe('{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}\n')
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('renderClaudeSettings() — issues #27, #29', () => {
  it('produces valid JSON', () => {
    expect(() => parseClaude()).not.toThrow()
  })

  it('declares the Claude settings JSON Schema', () => {
    expect(parseClaude().$schema).toBe('https://json.schemastore.org/claude-code-settings.json')
  })

  it('bans the commit/push cheat paths via permissions.deny', () => {
    expect(parseClaude().permissions.deny.slice(0, 4)).toEqual([
      'Bash(git commit *--no-verify*)',
      'Bash(git commit *-n *)',
      'Bash(git push *--no-verify*)',
      'Bash(SKIP=*)',
    ])
  })

  it('denies edits to the protected config set (#29)', () => {
    const { deny } = parseClaude().permissions
    expect(deny).toContain('Edit(tsconfig.json)')
    expect(deny).toContain('Write(biome.json)')
    expect(deny).toContain('MultiEdit(.oxlintrc*)')
    expect(deny).toContain('Edit(lefthook.yml)')
    expect(deny).toContain('Edit(.claude/settings.json)')
    expect(deny).toContain('Edit(.codex/hooks.json)')
  })

  it('runs `kata verify --json` on Pre/PostToolUse and `kata verify && pnpm test` on Stop', () => {
    const { hooks } = parseClaude()
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe('kata verify && pnpm test')
  })

  it('matches the file-writing tools on Pre/PostToolUse', () => {
    const { hooks } = parseClaude()
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit')
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit')
  })

  it('gives the Stop gate a 180s timeout and no matcher', () => {
    const stop = parseClaude().hooks.Stop?.[0]
    expect(stop?.matcher).toBeUndefined()
    expect(stop?.hooks[0]?.timeout).toBe(180)
  })
})

describe('renderCodexHooks() — issue #28', () => {
  it('produces valid JSON', () => {
    expect(() => parseCodex()).not.toThrow()
  })

  it('has no permissions slot (Codex has no equivalent)', () => {
    expect(parseCodex()).not.toHaveProperty('permissions')
    expect(parseCodex()).not.toHaveProperty('$schema')
  })

  it('uses the Bash|apply_patch matcher (Codex tool-name limitation)', () => {
    const { hooks } = parseCodex()
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Bash|apply_patch')
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Bash|apply_patch')
  })
})

describe('renderAgentsHooks() — issue #200 (vendor-neutral .agents mirror)', () => {
  it('produces valid JSON with no vendor-specific slots', () => {
    expect(() => parseAgents()).not.toThrow()
    expect(parseAgents()).not.toHaveProperty('permissions')
    expect(parseAgents()).not.toHaveProperty('$schema')
  })

  it('uses the union tool matcher (covers Claude + Codex tool names)', () => {
    const { hooks } = parseAgents()
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit|Bash|apply_patch')
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit|Bash|apply_patch')
  })

  it('runs the same hook commands as the Claude/Codex configs', () => {
    const { hooks } = parseAgents()
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe('kata verify && pnpm test')
    expect(hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(180)
  })
})

describe('harness parity across .claude / .codex / .agents (#27, #28, #200)', () => {
  it('runs the identical command sequence across all three harnesses', () => {
    const commandsOf = (h: ClaudeSettings['hooks']): Array<string | undefined> => [
      h.PreToolUse?.[0]?.hooks[0]?.command,
      h.PostToolUse?.[0]?.hooks[0]?.command,
      h.Stop?.[0]?.hooks[0]?.command,
    ]
    const expected = ['kata verify --json', 'kata verify --json', 'kata verify && pnpm test']
    expect(commandsOf(parseClaude().hooks)).toEqual(expected)
    expect(commandsOf(parseCodex().hooks)).toEqual(expected)
    expect(commandsOf(parseAgents().hooks)).toEqual(expected)
  })
})

describe('renderBiomeJson() / renderOxlintrc() — issue #200', () => {
  it('biome.json: valid JSON, formatter on, linter off (oxlint is the linter)', () => {
    const biome = JSON.parse(renderBiomeJson()) as {
      $schema: string
      formatter: { enabled: boolean }
      linter: { enabled: boolean }
    }
    expect(biome.$schema).toContain('@biomejs/biome')
    expect(biome.formatter.enabled).toBe(true)
    expect(biome.linter.enabled).toBe(false)
  })

  it('.oxlintrc.json: valid JSON enforcing the `any` ban and no-default-export', () => {
    const oxlint = JSON.parse(renderOxlintrc()) as { rules: Record<string, string> }
    expect(oxlint.rules['typescript/no-explicit-any']).toBe('error')
    expect(oxlint.rules['import/no-default-export']).toBe('error')
  })

  it('both end in exactly one trailing newline', () => {
    for (const text of [renderBiomeJson(), renderOxlintrc()]) {
      expect(text.endsWith('\n')).toBe(true)
      expect(text.endsWith('\n\n')).toBe(false)
    }
  })
})

describe('renderAgentsMd() / renderClaudeMd() — issue #31', () => {
  it('keeps AGENTS.md under 50 lines (pointer-style per the article)', () => {
    expect(renderAgentsMd().trimEnd().split('\n').length).toBeLessThan(50)
  })

  it('documents verify commands, conventions and prohibitions', () => {
    const md = renderAgentsMd()
    expect(md).toContain('# Agent Instructions')
    expect(md).toContain('kata verify')
    expect(md).toContain('`any` is forbidden')
    expect(md).toContain('--no-verify')
  })

  it("distinguishes this app's own ADRs from a version-pinned framework link (issue #213)", () => {
    const md = renderAgentsMd()
    expect(md).toContain("This app's own decisions live as ADRs under `docs/adr/`")
    expect(md).toMatch(/https:\/\/github\.com\/VicenzoMF\/kata\/tree\/v\d+\.\d+\.\d+\/docs\/adr/)
    // Never a relative path into a directory the consumer's project doesn't have.
    expect(md).not.toMatch(/`docs\/adr\/\d{4}-/)
  })

  it('CLAUDE.md imports AGENTS.md via the @-include directive', () => {
    expect(renderClaudeMd()).toContain('@AGENTS.md')
  })
})

describe('renderLefthookYml() — issue #130', () => {
  it('renders the lefthook pre-commit configuration with kata verify', () => {
    const yml = renderLefthookYml()
    expect(yml).toContain('pre-commit:')
    expect(yml).toContain('pnpm exec kata verify')
    expect(yml).toContain('pnpm exec biome check')
    expect(yml).toContain('pnpm exec oxlint')
  })
})

describe('renderMcpJson() — ADR-0023 (--with-docs-mcp)', () => {
  it('registers @katajs-framework/docs-mcp as a local stdio server via npx', () => {
    const json = JSON.parse(renderMcpJson())
    expect(json.mcpServers['kata-docs'].command).toBe('npx')
    expect(json.mcpServers['kata-docs'].args).toEqual(['-y', '@katajs-framework/docs-mcp'])
  })
})

describe('renderExample* — `kata init` app skeleton (issue #200)', () => {
  it('context.ts calls defineContext and re-exports the bound factory (ADR-0004)', () => {
    const src = renderExampleContext()
    expect(src).toContain("import { defineContext } from '@katajs-framework/core'")
    expect(src).toContain('export const k = defineContext({})')
    expect(src).toContain('export const { defineRoute, defineMiddleware, createApp } = k')
    expect(src).toContain('export type AppRegistry = typeof k.registry')
  })

  it('app.ts composes both modules and the app-level middleware chain (ADR-0012)', () => {
    const src = renderExampleApp()
    expect(src).toContain("import { createApp } from './context'")
    expect(src).toContain("import { requestLogger } from './middlewares/request-logger'")
    expect(src).toContain("import * as greetings from './modules/greetings/greetings.route'")
    expect(src).toContain("import * as health from './modules/health/health.route'")
    expect(src).toContain('modules: [health, greetings]')
    expect(src).toContain('middlewares: [requestLogger]')
  })

  it('main.ts serves the app from @hono/node-server', () => {
    const src = renderExampleMain()
    expect(src).toContain("import { serve } from '@hono/node-server'")
    expect(src).toContain("import { app } from './app'")
    expect(src).toContain('serve({ fetch: app.fetch, port }')
  })

  it('request-logger.ts is a no-DI middleware that provides nothing (ADR-0012)', () => {
    const src = renderExampleRequestLogger()
    expect(src).toContain("import { defineMiddleware } from '../context'")
    expect(src).toContain('provides: []')
    expect(src).toContain('await next()')
    // It must not c.set anything — provides:[] would otherwise mismatch (ADR-0004).
    expect(src).not.toMatch(/\bc\.set\(/)
  })

  it('health: schema + service + route + test + hurl, no inline schema in the route', () => {
    expect(renderExampleHealthSchema()).toContain('export const HealthSchema = z.object({')
    expect(renderExampleHealthSchema()).toContain("status: z.literal('ok')")
    expect(renderExampleHealthService()).toContain('export function checkHealth(): Health {')
    const route = renderExampleHealthRoute()
    expect(route).toContain("method: 'GET'")
    expect(route).toContain("path: '/health'")
    expect(route).toContain('input: {}')
    expect(route).toContain('output: HealthSchema')
    expect(route).not.toMatch(/\bz\./) // schemas imported by name (ADR-0005)
    expect(renderExampleHealthTest()).toContain("import { describe, expect, it } from 'vitest'")
    expect(renderExampleHealthTest()).toContain('checkHealth()')
    const hurl = renderExampleHealthHurl()
    expect(hurl).toContain('GET {{host}}/health')
    expect(hurl).toContain('jsonpath "$.status" == "ok"')
  })

  it('greetings: POST + GET routes with body/params schemas and a 404, no inline schema', () => {
    const schema = renderExampleGreetingsSchema()
    expect(schema).toContain('export const CreateGreetingBodySchema = z.object({')
    expect(schema).toContain('export const GreetingParamsSchema = z.object({')
    expect(schema).toContain('export const GreetingSchema = z.object({')
    const service = renderExampleGreetingsService()
    expect(service).toContain(
      'export function createGreeting(input: CreateGreetingBody): Greeting {',
    )
    expect(service).toContain('export function getGreeting(id: string): Greeting | null {')
    expect(service).toContain('crypto.randomUUID()')
    const route = renderExampleGreetingsRoute()
    expect(route).toContain("method: 'POST'")
    expect(route).toContain("path: '/greetings'")
    expect(route).toContain('input: { body: CreateGreetingBodySchema }')
    expect(route).toContain("method: 'GET'")
    expect(route).toContain("path: '/greetings/:id'")
    expect(route).toContain('input: { params: GreetingParamsSchema }')
    expect(route).toContain("c.error('not_found', 'Greeting not found', { status: 404 })")
    expect(route).not.toMatch(/\bz\./)
    expect(renderExampleGreetingsTest()).toContain("import { describe, expect, it } from 'vitest'")
    const hurl = renderExampleGreetingsHurl()
    expect(hurl).toContain('POST {{host}}/greetings')
    expect(hurl).toContain('greeting_id: jsonpath "$.id"')
    expect(hurl).toContain('GET {{host}}/greetings/{{greeting_id}}')
  })

  it('every generated source file ends in exactly one trailing newline', () => {
    const sources = [
      renderExampleContext(),
      renderExampleApp(),
      renderExampleMain(),
      renderExampleRequestLogger(),
      renderExampleHealthSchema(),
      renderExampleHealthService(),
      renderExampleHealthRoute(),
      renderExampleHealthTest(),
      renderExampleHealthHurl(),
      renderExampleGreetingsSchema(),
      renderExampleGreetingsService(),
      renderExampleGreetingsRoute(),
      renderExampleGreetingsTest(),
      renderExampleGreetingsHurl(),
      renderExampleGitignore(),
      renderExampleEnvExample(),
      renderExampleAdrTemplate(),
      renderExampleAdrReadme(),
    ]
    for (const src of sources) {
      expect(src.endsWith('\n')).toBe(true)
      expect(src.endsWith('\n\n')).toBe(false)
    }
  })

  it('.gitignore excludes app state (data/) and the real .env (issue #213)', () => {
    const gitignore = renderExampleGitignore()
    expect(gitignore).toContain('data/')
    expect(gitignore).toContain('.env')
  })

  it('.env.example documents JWT_SECRET, the one env var kata/jwt requires (issue #213)', () => {
    expect(renderExampleEnvExample()).toContain('JWT_SECRET=')
  })

  it('docs/adr/_template.md mirrors the ADR skeleton (issue #213)', () => {
    const template = renderExampleAdrTemplate()
    expect(template).toContain('# ADR-NNNN:')
    expect(template).toContain('## Decision')
    expect(template).toContain('## Consequences')
  })

  it('docs/adr/README.md distinguishes app ADRs from a version-pinned framework link (issue #213)', () => {
    const readme = renderExampleAdrReadme()
    expect(readme).toContain("this app's own")
    expect(readme).toMatch(
      /https:\/\/github\.com\/VicenzoMF\/kata\/tree\/v\d+\.\d+\.\d+\/docs\/adr/,
    )
    // Never a relative path into a directory the consumer's project doesn't have.
    expect(readme).not.toMatch(/`docs\/adr\/\d{4}-/)
  })

  it('package.json is named after the app and carries the kata + boot + harness deps', () => {
    const text = renderExamplePackageJson('my-app')
    expect(text.endsWith('\n')).toBe(true)
    const pkg = JSON.parse(text) as {
      name: string
      type: string
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.name).toBe('my-app')
    expect(pkg.type).toBe('module')
    expect(pkg.scripts.dev).toBe('tsx watch src/main.ts')
    expect(pkg.scripts.test).toBe('vitest run')
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit')
    expect(pkg.scripts.verify).toBe('kata verify')
    // Globbed, {{host}}-templated (#214): a module added later via `kata new`
    // is covered with no edit here, and HURL_HOST can point the suite at a
    // deployed environment instead of the localhost default.
    expect(pkg.scripts.hurl).toBe(
      'hurl --test --color --variable host=${HURL_HOST:-http://localhost:3000} src/modules/*/*.hurl',
    )
    // Published as `@katajs-framework/core`: the unscoped `katajs` is permanently blocked by
    // npm's name-similarity filter (the dormant `kata-js`), so the scope is forced.
    // The bin stays `kata`. The pin must track the CLI's own version — a hardcoded
    // range silently breaks `kata init` the moment a new minor ships.
    expect(pkg.dependencies['@katajs-framework/core']).toBe(`^${KATA_VERSION}`)
    expect(pkg.dependencies.hono).toBeDefined()
    expect(pkg.dependencies.zod).toBeDefined()
    expect(pkg.dependencies['@hono/node-server']).toBeDefined()
    expect(pkg.devDependencies['@biomejs/biome']).toBeDefined()
    expect(pkg.devDependencies.oxlint).toBeDefined()
    expect(pkg.devDependencies.lefthook).toBeDefined()
    expect(pkg.devDependencies.vitest).toBeDefined()
    expect(pkg.devDependencies.typescript).toBeDefined()
  })

  it('tsconfig.json: valid JSON, strict + Bundler resolution + node types', () => {
    const text = renderExampleTsconfig()
    expect(text.endsWith('\n')).toBe(true)
    const tsconfig = JSON.parse(text) as {
      compilerOptions: { strict: boolean; moduleResolution: string; types: string[] }
    }
    expect(tsconfig.compilerOptions.strict).toBe(true)
    expect(tsconfig.compilerOptions.moduleResolution).toBe('Bundler')
    expect(tsconfig.compilerOptions.types).toContain('node')
  })

  it('README.md is titled after the app and documents the example endpoints', () => {
    const readme = renderExampleReadme('my-app')
    expect(readme).toContain('# my-app')
    expect(readme).toContain('/health')
    expect(readme).toContain('/greetings')
    expect(readme).toContain('kata new')
  })
})

describe('renderModule* — `kata new <domain>` source files (Issue #102)', () => {
  it('route: POST + GET/:id, body/params schemas, a 404, no inline schema (mirrors greetings)', () => {
    const src = renderModuleRoute('ping')
    expect(src).toContain("import { defineRoute } from '../../context'")
    expect(src).toContain(
      "import { CreatePingBodySchema, PingParamsSchema, PingSchema } from './ping.schema'",
    )
    expect(src).toContain("import { createPing, getPing } from './ping.service'")
    expect(src).toContain("method: 'POST'")
    expect(src).toContain("path: '/ping'")
    expect(src).toContain('input: { body: CreatePingBodySchema }')
    expect(src).toContain('output: PingSchema')
    expect(src).toContain('handler: (c) => createPing(c.input.body)')
    expect(src).toContain("method: 'GET'")
    expect(src).toContain("path: '/ping/:id'")
    expect(src).toContain('input: { params: PingParamsSchema }')
    expect(src).toContain("c.error('not_found', 'Ping not found', { status: 404 })")
    expect(src).not.toMatch(/\bz\./) // schemas imported by name (ADR-0005)
  })

  it('service creates and reads back via an in-memory store', () => {
    const src = renderModuleService('ping')
    expect(src).toContain("import type { CreatePingBody, Ping } from './ping.schema'")
    expect(src).toContain('export function createPing(input: CreatePingBody): Ping {')
    expect(src).toContain('crypto.randomUUID()')
    expect(src).toContain('export function getPing(id: string): Ping | null {')
  })

  it('schema defines the body/params/response Zod objects', () => {
    const src = renderModuleSchema('ping')
    expect(src).toContain("import { z } from 'zod'")
    expect(src).toContain('export const CreatePingBodySchema = z.object({')
    expect(src).toContain('export const PingParamsSchema = z.object({')
    expect(src).toContain('export const PingSchema = z.object({')
    expect(src).toContain('export type CreatePingBody = z.infer<typeof CreatePingBodySchema>')
    expect(src).toContain('export type Ping = z.infer<typeof PingSchema>')
  })

  it('test creates, reads back, and 404s on an unknown id', () => {
    const src = renderModuleTest('ping')
    expect(src).toContain("import { describe, expect, it } from 'vitest'")
    expect(src).toContain("import { createPing, getPing } from './ping.service'")
    expect(src).toContain("describe('ping.service', () => {")
    expect(src).toContain('toBeNull()')
  })

  it('hurl: POST then GET by captured id, templated {{host}}', () => {
    const src = renderModuleHurl('ping')
    expect(src).toContain('POST {{host}}/ping')
    expect(src).toContain('ping_id: jsonpath "$.id"')
    expect(src).toContain('GET {{host}}/ping/{{ping_id}}')
    expect(src).toContain('HTTP 200')
    expect(src).toContain('jsonpath "$.name" == "Ada"')
  })
})

describe('determinism', () => {
  it('renders byte-identical output on repeated calls', () => {
    expect(renderClaudeSettings()).toBe(renderClaudeSettings())
    expect(renderCodexHooks()).toBe(renderCodexHooks())
    expect(renderAgentsHooks()).toBe(renderAgentsHooks())
    expect(renderAgentsMd()).toBe(renderAgentsMd())
    expect(renderBiomeJson()).toBe(renderBiomeJson())
    expect(renderOxlintrc()).toBe(renderOxlintrc())
  })

  it('renders byte-identical app files on repeated calls', () => {
    expect(renderExampleApp()).toBe(renderExampleApp())
    expect(renderExampleGreetingsRoute()).toBe(renderExampleGreetingsRoute())
    expect(renderExamplePackageJson('x')).toBe(renderExamplePackageJson('x'))
    expect(renderExampleTsconfig()).toBe(renderExampleTsconfig())
  })
})
