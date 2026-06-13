import { describe, expect, it } from 'vitest'

import { renderClaudeSettings, renderCodexHooks, serialize } from './generators.js'
import type { ClaudeSettings, CodexHooks } from './templates/types.js'

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

describe('renderClaudeSettings() — issue #27', () => {
  it('produces valid JSON', () => {
    expect(() => parseClaude()).not.toThrow()
  })

  it('declares the Claude settings JSON Schema', () => {
    expect(parseClaude().$schema).toBe('https://json.schemastore.org/claude-code-settings.json')
  })

  it('bans the commit/push cheat paths via permissions.deny', () => {
    expect(parseClaude().permissions.deny).toEqual([
      'Bash(git commit *--no-verify*)',
      'Bash(git commit *-n *)',
      'Bash(git push *--no-verify*)',
      'Bash(SKIP=*)',
    ])
  })

  it('wires Pre/Post/Stop hooks to `kata verify --json`', () => {
    const { hooks } = parseClaude()
    const commands = [
      hooks.PreToolUse?.[0]?.hooks[0]?.command,
      hooks.PostToolUse?.[0]?.hooks[0]?.command,
      hooks.Stop?.[0]?.hooks[0]?.command,
    ]
    expect(commands).toEqual(['kata verify --json', 'kata verify --json', 'kata verify --json'])
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

  it('gives the Stop ladder a 180s timeout and no matcher', () => {
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

  it('wires Pre/Post/Stop hooks to `kata verify --json`', () => {
    const { hooks } = parseCodex()
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe('kata verify --json')
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe('kata verify --json')
  })

  it('gives the Stop ladder a 180s timeout and no matcher', () => {
    const stop = parseCodex().hooks.Stop?.[0]
    expect(stop?.matcher).toBeUndefined()
    expect(stop?.hooks[0]?.timeout).toBe(180)
  })
})

describe('Claude/Codex parity (the point of #27 + #28)', () => {
  it('runs the identical command across both harnesses', () => {
    const claude = parseClaude().hooks
    const codex = parseCodex().hooks
    const commandsOf = (h: typeof claude): Array<string | undefined> => [
      h.PreToolUse?.[0]?.hooks[0]?.command,
      h.PostToolUse?.[0]?.hooks[0]?.command,
      h.Stop?.[0]?.hooks[0]?.command,
    ]
    expect(commandsOf(claude)).toEqual(commandsOf(codex))
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

describe('determinism', () => {
  it('renders byte-identical output on repeated calls', () => {
    expect(renderClaudeSettings()).toBe(renderClaudeSettings())
    expect(renderCodexHooks()).toBe(renderCodexHooks())
  })
})
