import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runCli } from './cli'
import { rules } from './rules'
import { runVerify } from './runner'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const helloDir = resolve(repoRoot, 'examples/hello')

describe('runCli() — help', () => {
  it('prints usage and exits 0', () => {
    const { output, exitCode } = runCli(['--help'], repoRoot)
    expect(exitCode).toBe(0)
    expect(output).toContain('Usage:')
    expect(output).toContain('kata/no-route-without-output-schema')
    expect(output).toContain('--strict-coverage')
  })

  it('lists exactly one help line per rule that actually runs (issue #212)', () => {
    const { output } = runCli(['--help'], repoRoot)
    const ruleLines = output.split('\n').filter((line) => /^ {2}kata\//.test(line))
    expect(ruleLines.length).toBe(rules.length)
  })

  it('lists every rule with its description and ADR reference', () => {
    const { output } = runCli(['--help'], repoRoot)
    for (const rule of rules) {
      expect(output).toContain(rule.name)
      expect(output).toContain(rule.description)
      expect(output).toContain(`(${rule.adr})`)
    }
  })
})

describe('runCli() — the hello example is clean', () => {
  // ADR conformance + acceptance for #5: zero false positives on the example.
  it('reports no problems and exits 0', () => {
    const { output, exitCode } = runCli([], helloDir)
    expect(exitCode).toBe(0)
    expect(output).toContain('no problems found')
  })

  it('emits an empty (no-op) hook object in --json mode', () => {
    const { output, exitCode } = runCli(['--json'], helloDir)
    expect(exitCode).toBe(0)
    expect(JSON.parse(output)).toEqual({})
  })

  it('has no suppressed checks — every middleware in its chains resolves (#206)', () => {
    // hello's app-level chain is `[cors(), secureHeaders(), bodyLimit(...)]`,
    // exactly the shape that used to disable kata/scoped-slot-not-provided
    // project-wide. They resolve through @katajs-framework/core's provides.json manifest now.
    const { output, exitCode } = runCli(['--strict-coverage'], helloDir)
    expect(exitCode).toBe(0)
    expect(output).not.toContain('suppressed')
  })
})

describe('runCli() — a project with violations', () => {
  let fixture: string
  /** A project whose only scoped read hides behind an unresolvable chain entry. */
  let suppressedFixture: string

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'kata-verify-'))
    const moduleDir = join(fixture, 'src', 'modules', 'users')
    mkdirSync(moduleDir, { recursive: true })

    suppressedFixture = mkdtempSync(join(tmpdir(), 'kata-verify-suppressed-'))
    const suppressedModuleDir = join(suppressedFixture, 'src', 'modules', 'users')
    mkdirSync(suppressedModuleDir, { recursive: true })
    writeFileSync(
      join(suppressedFixture, 'src', 'context.ts'),
      `import { defineContext, scoped } from '@katajs-framework/core'
export const k = defineContext({ currentUser: scoped() })
`,
    )
    writeFileSync(
      join(suppressedModuleDir, 'users.route.ts'),
      `import { z } from 'zod'
import { cors } from '@katajs-framework/core'
import { defineRoute } from '../../context'

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [cors()],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
`,
    )

    writeFileSync(
      join(fixture, 'src', 'context.ts'),
      `import { defineContext, scoped, singleton } from '@katajs-framework/core'
export const k = defineContext({
  logger: singleton({ info() {} }),
  currentUser: scoped(),
})
`,
    )
    writeFileSync(
      join(moduleDir, 'users.route.ts'),
      `import { z } from 'zod'
import { defineRoute } from '../../context'

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  input: {},
  output: z.object({}),
  handler: async (c) => c.get('currentUserr'),
})

export const listRoute = defineRoute({
  method: 'GET',
  path: '/users',
  input: {},
  handler: async () => [],
})
`,
    )
  })

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    rmSync(suppressedFixture, { recursive: true, force: true })
  })

  it('detects the missing output schema, the unregistered key, and the inline schema', () => {
    // meRoute's `output: z.object({})` is both a present output (so no
    // missing-output issue there) and an inline schema (kata/inline-schema);
    // listRoute is missing `output` entirely; meRoute reads an unregistered key.
    const result = runVerify(fixture)
    const ruleNames = result.issues.map((issue) => issue.rule).sort()
    expect(ruleNames).toEqual([
      'kata/context-key-not-registered',
      'kata/inline-schema',
      'kata/no-route-without-output-schema',
    ])
    expect(result.errorCount).toBe(3)
  })

  it('exits 1 in human mode', () => {
    const { output, exitCode } = runCli([], fixture)
    expect(exitCode).toBe(1)
    expect(output).toContain('3 problems (3 errors)')
  })

  it('emits PostToolUse-injectable JSON and exits 0 in --json mode (acceptance #3)', () => {
    const { output, exitCode } = runCli(['--json'], fixture)
    expect(exitCode).toBe(0)

    const payload = JSON.parse(output) as {
      decision?: string
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    expect(payload.decision).toBe('block')
    expect(payload.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    const context = payload.hookSpecificOutput?.additionalContext ?? ''
    expect(context).toContain("c.get('currentUserr')")
    expect(context).toContain("missing the required 'output' schema")
    expect(context).toContain('built inline with z.object')
  })

  it('reports the coverage gap and exits non-zero under --strict-coverage', () => {
    // The fixture's route chains through an unresolvable `cors()` (no manifest
    // is installed in the temp dir), so the scoped read cannot be proven.
    const { output, exitCode } = runCli(['--strict-coverage'], suppressedFixture)
    expect(exitCode).toBe(1)
    expect(output).toContain('no problems found')
    expect(output).toContain('kata/scoped-slot-not-provided')
    expect(output).toContain('cors()')
  })

  it('reports the same gap without failing when --strict-coverage is absent', () => {
    const { output, exitCode } = runCli([], suppressedFixture)
    expect(exitCode).toBe(0)
    expect(output).toContain('1 check suppressed')
  })

  it('carries suppressions into the hook JSON without blocking', () => {
    const { output } = runCli(['--json'], suppressedFixture)
    const payload = JSON.parse(output) as {
      decision?: string
      suppressions?: { rule: string; affectedCount: number }[]
    }
    expect(payload.decision).toBeUndefined()
    expect(payload.suppressions?.[0]?.rule).toBe('kata/scoped-slot-not-provided')
    expect(payload.suppressions?.[0]?.affectedCount).toBe(1)
  })

  it('detects an injected typo well within the 100ms budget (acceptance #5)', () => {
    const start = performance.now()
    const result = runVerify(fixture)
    const elapsed = performance.now() - start
    expect(result.issues.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(100)
  })
})
