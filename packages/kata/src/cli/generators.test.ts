import { describe, expect, it } from 'vitest'

import {
  renderAgentsMd,
  renderClaudeMd,
  renderClaudeSettings,
  renderCodexHooks,
  serialize,
} from './generators'
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

describe('determinism', () => {
  it('renders byte-identical output on repeated calls', () => {
    expect(renderClaudeSettings()).toBe(renderClaudeSettings())
    expect(renderCodexHooks()).toBe(renderCodexHooks())
    expect(renderAgentsMd()).toBe(renderAgentsMd())
    expect(renderClaudeMd()).toBe(renderClaudeMd())
  })
})
