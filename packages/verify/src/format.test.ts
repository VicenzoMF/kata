import { describe, expect, it } from 'vitest'

import { formatHookOutput, formatHuman, renderIssue, renderSuppression } from './format'
import type { Issue, Suppression, VerifyResult } from './types'

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

const suppression: Suppression = {
  rule: 'kata/scoped-slot-not-provided',
  reason: 'could not resolve `cors()` in createApp({ middlewares })',
  file: 'src/main.ts',
  line: 17,
  column: 18,
  affectedCount: 12,
}

function result(issues: readonly Issue[], suppressions: readonly Suppression[] = []): VerifyResult {
  return {
    issues,
    suppressions,
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

describe('renderSuppression()', () => {
  it('names the rule, the scope of the gap, the reason, and the location', () => {
    const text = renderSuppression(suppression)
    expect(text).toContain('kata/scoped-slot-not-provided')
    expect(text).toContain('suppressed for 12 checks')
    expect(text).toContain('could not resolve `cors()`')
    expect(text).toContain('src/main.ts:17:18')
  })

  it('omits the count when it is unknowable', () => {
    const text = renderSuppression({ ...suppression, affectedCount: 0 })
    expect(text).toContain('suppressed —')
    expect(text).not.toContain('0 check')
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

  it('reports suppressions on an otherwise clean run — a green check must not hide them', () => {
    const text = formatHuman(result([], [suppression]))
    expect(text).toContain('no problems found')
    expect(text).toContain('1 check suppressed')
    expect(text).toContain('could not resolve `cors()`')
    expect(text).toContain('--strict-coverage')
  })

  it('reports suppressions alongside issues', () => {
    const text = formatHuman(result([issue], [suppression]))
    expect(text).toContain('ERROR:')
    expect(text).toContain('1 check suppressed')
    expect(text).toContain('1 problem (1 error)')
  })

  it('changes the footer wording under --strict-coverage', () => {
    const text = formatHuman(result([], [suppression]), { strictCoverage: true })
    expect(text).toContain('--strict-coverage: an unproven check counts as a failure.')
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

  it('tells the agent about suppressions without blocking on them', () => {
    const out = formatHookOutput(result([], [suppression]))
    if (!('hookSpecificOutput' in out)) throw new Error('expected a hook payload')

    expect(out.decision).toBeUndefined()
    expect(out.hookSpecificOutput.additionalContext).toContain('suppressed check')
    expect(out.hookSpecificOutput.additionalContext).toContain('could not resolve `cors()`')
    expect(out.suppressions).toEqual([suppression])
  })

  it('blocks on suppressions under --strict-coverage', () => {
    const out = formatHookOutput(result([], [suppression]), { strictCoverage: true })
    if (!('hookSpecificOutput' in out)) throw new Error('expected a hook payload')

    expect(out.decision).toBe('block')
    expect(out.reason).toContain('--strict-coverage')
  })

  it('carries both violations and suppressions when there are both', () => {
    const out = formatHookOutput(result([issue], [suppression]))
    if (!('hookSpecificOutput' in out)) throw new Error('expected a hook payload')

    expect(out.decision).toBe('block')
    expect(out.reason).toContain('1 violation')
    expect(out.hookSpecificOutput.additionalContext).toContain(issue.message)
    expect(out.hookSpecificOutput.additionalContext).toContain(suppression.reason)
  })
})
