import { describe, expect, it } from 'vitest'

import { formatHookOutput, formatHuman, renderIssue } from './format'
import type { Issue, VerifyResult } from './types'

const issue: Issue = {
  rule: 'kata/no-route-without-output-schema',
  severity: 'error',
  file: 'src/modules/users/users.route.ts',
  line: 12,
  column: 3,
  message: "defineRoute is missing the required 'output' schema",
  why: 'responses are validated at runtime. See ADR-0003.',
  fix: 'Add an `output:` field.',
  example: { bad: 'defineRoute({\n  input: {},\n})', good: 'defineRoute({\n  output: S,\n})' },
}

function result(issues: readonly Issue[]): VerifyResult {
  return {
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
    fileCount: 3,
  }
}

describe('renderIssue()', () => {
  it('uses the ERROR / WHY / FIX / EXAMPLE template', () => {
    const text = renderIssue(issue)
    expect(text).toContain('ERROR:')
    expect(text).toContain('WHY:')
    expect(text).toContain('FIX:')
    expect(text).toContain('EXAMPLE:')
    expect(text).toContain('// Bad:')
    expect(text).toContain('// Good:')
    expect(text).toContain('src/modules/users/users.route.ts:12:3')
  })
})

describe('formatHuman()', () => {
  it('reports a clean run', () => {
    expect(formatHuman(result([]))).toContain('no problems found')
  })

  it('renders issues with a summary footer', () => {
    const text = formatHuman(result([issue]))
    expect(text).toContain('ERROR:')
    expect(text).toContain('1 problem (1 error)')
  })
})

describe('formatHookOutput()', () => {
  it('is an empty object on a clean run', () => {
    expect(formatHookOutput(result([]))).toEqual({})
  })

  it('emits the PostToolUse additionalContext shape on violations', () => {
    const out = formatHookOutput(result([issue]))
    expect('hookSpecificOutput' in out).toBe(true)
    if (!('hookSpecificOutput' in out)) throw new Error('expected a hook payload')

    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(typeof out.hookSpecificOutput.additionalContext).toBe('string')
    expect(out.hookSpecificOutput.additionalContext).toContain('ERROR:')
    expect(out.hookSpecificOutput.additionalContext).toContain(issue.message)
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('1 violation')
  })

  it('produces JSON a PostToolUse hook can parse', () => {
    const out = formatHookOutput(result([issue]))
    const roundTripped = JSON.parse(JSON.stringify(out)) as Record<string, unknown>
    expect(roundTripped).toHaveProperty('hookSpecificOutput.additionalContext')
  })
})
