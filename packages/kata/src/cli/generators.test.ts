import { describe, expect, it } from 'vitest'

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
  serialize,
} from './generators'
import { examplePackageJson, exampleTsconfig } from './templates/example'
import type { ClaudeSettings, CodexHooks } from './templates/types'

function parseClaude(): ClaudeSettings {
  return JSON.parse(renderClaudeSettings()) as ClaudeSettings
}

function parseCodex(): CodexHooks {
  return JSON.parse(renderCodexHooks()) as CodexHooks
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
    // The command bans lead the deny list; the config-edit bans (#29) follow.
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
    expect(deny).toContain('Write(.github/workflows/**)')
    expect(deny).toContain('Edit(.claude/settings.json)')
    expect(deny).toContain('Edit(.codex/hooks.json)')
    expect(deny).toContain('Edit(kata.config.ts)')
  })

  it('protects every config glob with Edit, Write and MultiEdit (#29)', () => {
    const { deny } = parseClaude().permissions
    const globs = [
      'tsconfig.json',
      'tsconfig.*.json',
      'biome.json',
      '.oxlintrc*',
      'lefthook.yml',
      'kata.config.ts',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.github/workflows/**',
      '.claude/settings.json',
      '.codex/hooks.json',
    ]
    for (const glob of globs) {
      for (const tool of ['Edit', 'Write', 'MultiEdit']) {
        expect(deny).toContain(`${tool}(${glob})`)
      }
    }
  })

  it('runs `kata verify --json` on Pre/PostToolUse and `pnpm test` on Stop', () => {
    const { hooks } = parseClaude()
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe('pnpm test')
  })

  it('matches the file-writing tools on Pre/PostToolUse', () => {
    const { hooks } = parseClaude()
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit')
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit')
  })

  it('invokes `kata verify --json` from PostToolUse (the issue #27 line)', () => {
    // Literal substring the acceptance criterion names verbatim.
    expect(renderClaudeSettings()).toContain('kata verify --json')
    expect(parseClaude().hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
  })

  it('gives the Stop gate a 180s timeout and no matcher', () => {
    const stop = parseClaude().hooks.Stop?.[0]
    expect(stop?.matcher).toBeUndefined()
    expect(stop?.hooks[0]?.timeout).toBe(180)
  })

  it('does not set a timeout on the fast Pre/PostToolUse hooks', () => {
    const { hooks } = parseClaude()
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.timeout).toBeUndefined()
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.timeout).toBeUndefined()
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

  it('runs `kata verify --json` on Pre/PostToolUse and `pnpm test` on Stop', () => {
    const { hooks } = parseCodex()
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe('pnpm test')
  })

  it('gives the Stop gate a 180s timeout and no matcher', () => {
    const stop = parseCodex().hooks.Stop?.[0]
    expect(stop?.matcher).toBeUndefined()
    expect(stop?.hooks[0]?.timeout).toBe(180)
  })
})

describe('Claude/Codex parity (the point of #27 + #28)', () => {
  it('runs the identical command sequence across both harnesses', () => {
    const claude = parseClaude().hooks
    const codex = parseCodex().hooks
    const commandsOf = (h: typeof claude): Array<string | undefined> => [
      h.PreToolUse?.[0]?.hooks[0]?.command,
      h.PostToolUse?.[0]?.hooks[0]?.command,
      h.Stop?.[0]?.hooks[0]?.command,
    ]
    expect(commandsOf(claude)).toEqual(commandsOf(codex))
    expect(commandsOf(claude)).toEqual(['kata verify --json', 'kata verify --json', 'pnpm test'])
  })

  it('registers the same three events with the same Stop timeout', () => {
    const claude = parseClaude().hooks
    const codex = parseCodex().hooks
    const shapeOf = (h: typeof claude) => ({
      events: Object.keys(h),
      stopTimeout: h.Stop?.[0]?.hooks[0]?.timeout,
    })
    expect(shapeOf(claude)).toEqual(shapeOf(codex))
  })

  it('differs only in the tool matcher', () => {
    expect(parseClaude().hooks.PostToolUse?.[0]?.matcher).not.toBe(
      parseCodex().hooks.PostToolUse?.[0]?.matcher,
    )
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
    expect(md).toContain('pnpm test')
    expect(md).toContain('`any` is forbidden')
    expect(md).toContain('--no-verify')
  })

  it('CLAUDE.md imports AGENTS.md via the @-include directive', () => {
    expect(renderClaudeMd()).toContain('@AGENTS.md')
  })

  it('renders a single trailing newline, no blank-line padding', () => {
    expect(renderAgentsMd().endsWith('\n')).toBe(true)
    expect(renderAgentsMd().endsWith('\n\n')).toBe(false)
    expect(renderClaudeMd().endsWith('\n')).toBe(true)
    expect(renderClaudeMd().endsWith('\n\n')).toBe(false)
  })
})

describe('renderExample* — `kata init --with-example` source files (ADR-0015 / #101)', () => {
  it('context.ts calls defineContext and re-exports createApp / defineRoute (ADR-0004)', () => {
    const src = renderExampleContext()
    expect(src).toContain("import { defineContext } from 'kata'")
    expect(src).toContain('export const k = defineContext({})')
    expect(src).toContain('export const { defineRoute, createApp } = k')
  })

  it('main.ts wires createApp({ modules: [health] }) to serve from @hono/node-server', () => {
    const src = renderExampleMain()
    expect(src).toContain("import { serve } from '@hono/node-server'")
    expect(src).toContain("import * as health from './modules/health/health.route'")
    expect(src).toContain('createApp({ modules: [health] })')
    expect(src).toContain('serve({ fetch: app.fetch, port }')
  })

  it('health.route.ts declares GET /health with input {} and output HealthSchema (ADR-0003)', () => {
    const src = renderExampleHealthRoute()
    expect(src).toContain("method: 'GET'")
    expect(src).toContain("path: '/health'")
    expect(src).toContain('input: {}')
    expect(src).toContain('output: HealthSchema')
    expect(src).toContain("import { HealthSchema } from './health.schema'")
  })

  it('health.route.ts builds no schema inline — kata/inline-schema stays clean (ADR-0005)', () => {
    // The route imports HealthSchema by name; any `z.` construction in a
    // *.route.ts file would fail `kata verify` in the generated app.
    expect(renderExampleHealthRoute()).not.toMatch(/\bz\./)
  })

  it('health.schema.ts holds the HealthSchema Zod DTO (ADR-0005)', () => {
    const src = renderExampleHealthSchema()
    expect(src).toContain("import { z } from 'zod'")
    expect(src).toContain('export const HealthSchema = z.object({')
    expect(src).toContain("status: z.literal('ok')")
  })

  it('every generated source file ends in exactly one trailing newline', () => {
    const sources = [
      renderExampleContext(),
      renderExampleMain(),
      renderExampleHealthRoute(),
      renderExampleHealthSchema(),
    ]
    for (const src of sources) {
      expect(src.endsWith('\n')).toBe(true)
      expect(src.endsWith('\n\n')).toBe(false)
    }
  })

  it('package.json serialises the template object, with kata + boot deps', () => {
    const text = renderExamplePackageJson()
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(examplePackageJson)
    expect(examplePackageJson.type).toBe('module')
    expect(examplePackageJson.dependencies.kata).toBe('^0.1.0')
    expect(examplePackageJson.dependencies['@hono/node-server']).toBeDefined()
    expect(examplePackageJson.dependencies.zod).toBeDefined()
    expect(examplePackageJson.scripts.start).toBe('tsx src/main.ts')
  })

  it('tsconfig.json serialises the template object: strict + Bundler resolution + node types', () => {
    const text = renderExampleTsconfig()
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(exampleTsconfig)
    expect(exampleTsconfig.compilerOptions.strict).toBe(true)
    expect(exampleTsconfig.compilerOptions.moduleResolution).toBe('Bundler')
    expect(exampleTsconfig.compilerOptions.types).toContain('node')
  })

  it('serialises both manifests with 2-space JSON (Biome formatter parity)', () => {
    expect(renderExamplePackageJson()).toBe(serialize(examplePackageJson))
    expect(renderExampleTsconfig()).toBe(serialize(exampleTsconfig))
  })
})

describe('determinism', () => {
  it('renders byte-identical output on repeated calls', () => {
    expect(renderClaudeSettings()).toBe(renderClaudeSettings())
    expect(renderCodexHooks()).toBe(renderCodexHooks())
    expect(renderAgentsMd()).toBe(renderAgentsMd())
    expect(renderClaudeMd()).toBe(renderClaudeMd())
  })

  it('renders byte-identical example files on repeated calls', () => {
    expect(renderExampleContext()).toBe(renderExampleContext())
    expect(renderExampleMain()).toBe(renderExampleMain())
    expect(renderExampleHealthRoute()).toBe(renderExampleHealthRoute())
    expect(renderExampleHealthSchema()).toBe(renderExampleHealthSchema())
    expect(renderExamplePackageJson()).toBe(renderExamplePackageJson())
    expect(renderExampleTsconfig()).toBe(renderExampleTsconfig())
  })
})
