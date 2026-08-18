import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ErrorBody } from './errors'
import {
  buildErrorBody,
  ErrorBodySchema,
  FieldIssueSchema,
  formatZodIssues,
  serializeError,
} from './errors'

function issuesOf(schema: z.ZodTypeAny, value: unknown) {
  const result = schema.safeParse(value)
  if (result.success) throw new Error('expected schema to fail')
  return formatZodIssues(result.error)
}

describe('formatZodIssues()', () => {
  it('serialises a simple field error', () => {
    const issues = issuesOf(z.object({ email: z.string().email() }), { email: 'not-email' })
    expect(issues).toEqual([{ path: 'email', message: 'Invalid email', code: 'invalid_string' }])
  })

  it('joins nested object paths with dots', () => {
    const schema = z.object({ user: z.object({ profile: z.object({ age: z.number() }) }) })
    const issues = issuesOf(schema, { user: { profile: { age: 'old' } } })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.path).toBe('user.profile.age')
  })

  it('wraps array indices in brackets', () => {
    const schema = z.object({ items: z.array(z.object({ qty: z.number().positive() })) })
    const issues = issuesOf(schema, { items: [{ qty: 1 }, { qty: 0 }] })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.path).toBe('items[1].qty')
    expect(issues[0]?.code).toBe('too_small')
  })

  it('reports multiple issues in source order', () => {
    const schema = z.object({ a: z.string(), b: z.number() })
    const issues = issuesOf(schema, { a: 1, b: 'two' })
    expect(issues.map((i) => i.path)).toEqual(['a', 'b'])
  })

  it('emits empty path for root-level type errors', () => {
    const issues = issuesOf(z.object({ name: z.string() }), null)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.path).toBe('')
    expect(issues[0]?.code).toBe('invalid_type')
  })

  it('preserves expected and received on invalid_type', () => {
    const issues = issuesOf(z.object({ name: z.string() }), { name: 123 })
    expect(issues[0]).toMatchObject({
      path: 'name',
      code: 'invalid_type',
      expected: 'string',
      received: 'number',
    })
  })

  it('omits expected/received keys when the issue does not carry them', () => {
    const issues = issuesOf(z.object({ email: z.string().email() }), { email: 'x' })
    expect(issues[0]).not.toHaveProperty('expected')
    expect(issues[0]).not.toHaveProperty('received')
  })
})

describe('buildErrorBody()', () => {
  it('maps the code argument to the wire field `error` and keeps the message', () => {
    expect(buildErrorBody('not_found', 'User not found')).toEqual({
      error: 'not_found',
      message: 'User not found',
    })
  })

  it('omits `issues` when no extra is provided', () => {
    expect(buildErrorBody('not_found', 'User not found')).not.toHaveProperty('issues')
  })

  it('attaches `issues` when supplied via extra', () => {
    const issues = { body: [{ path: 'email', message: 'Invalid email', code: 'invalid_string' }] }
    expect(
      buildErrorBody('validation_failed', 'Request input validation failed', { issues }),
    ).toEqual({
      error: 'validation_failed',
      message: 'Request input validation failed',
      issues,
    })
  })

  it('never leaks `status` into the body (status drives the HTTP code, not the envelope)', () => {
    const body = buildErrorBody('internal_error', 'Internal server error', { status: 500 })
    expect(body).not.toHaveProperty('status')
    expect(body).toEqual({ error: 'internal_error', message: 'Internal server error' })
  })
})

describe('ErrorBodySchema (ADR-0011)', () => {
  it('accepts the envelope buildErrorBody produces without issues', () => {
    const parsed = ErrorBodySchema.safeParse(buildErrorBody('not_found', 'User not found'))
    expect(parsed.success).toBe(true)
  })

  it('accepts the envelope with structured issues attached', () => {
    const issues = {
      body: formatZodIssues(z.object({ email: z.string().email() }).safeParse({}).error!),
    }
    const envelope = buildErrorBody('validation_failed', 'Request input validation failed', {
      issues,
    })
    expect(ErrorBodySchema.safeParse(envelope).success).toBe(true)
  })

  it('rejects a body missing the required `message`', () => {
    expect(ErrorBodySchema.safeParse({ error: 'not_found' }).success).toBe(false)
  })

  it('its inferred type is assignable to ErrorBody', () => {
    // The cast is the proof: if `z.infer<typeof ErrorBodySchema>` drifted from
    // `ErrorBody`, this line would fail `tsc` (the package typecheck).
    const asErrorBody: ErrorBody = ErrorBodySchema.parse({ error: 'x', message: 'y' })
    expect(asErrorBody).toEqual({ error: 'x', message: 'y' })
  })
})

describe('FieldIssueSchema (ADR-0011)', () => {
  it('round-trips a formatZodIssues entry', () => {
    const [issue] = formatZodIssues(z.object({ name: z.string() }).safeParse({ name: 1 }).error!)
    expect(FieldIssueSchema.safeParse(issue).success).toBe(true)
  })
})

describe('serializeError() (issue #210)', () => {
  it('flattens name, message and stack onto plain, enumerable fields', () => {
    const err = new Error('boom')
    const serialized = serializeError(err)
    expect(serialized.name).toBe('Error')
    expect(serialized.message).toBe('boom')
    expect(serialized.stack).toEqual(expect.any(String))
    // The whole point: a naive JSON.stringify-based logger must not lose this.
    expect(JSON.parse(JSON.stringify(serialized))).toMatchObject({ name: 'Error', message: 'boom' })
  })

  it('walks a `cause` chain', () => {
    const root = new Error('root cause')
    const wrapped = new Error('wrapped', { cause: root })
    const serialized = serializeError(wrapped)
    expect(serialized.cause).toMatchObject({ name: 'Error', message: 'root cause' })
  })

  it('caps the `cause` chain depth and does not throw on a self-referencing cycle', () => {
    const cyclic = new Error('cyclic', { cause: undefined })
    cyclic.cause = cyclic
    expect(() => serializeError(cyclic)).not.toThrow()
    let depth = 0
    let node: { cause?: unknown } | undefined = serializeError(cyclic)
    while (node?.cause) {
      depth++
      node = node.cause as { cause?: unknown }
      if (depth > 10) break // safety valve so a regression fails fast, not hangs
    }
    expect(depth).toBeLessThanOrEqual(5)
  })

  it('caps a long acyclic `cause` chain at the same depth', () => {
    let err = new Error('level 0')
    for (let i = 1; i <= 10; i++) {
      err = new Error(`level ${i}`, { cause: err })
    }
    let depth = 0
    let node: { cause?: unknown } | undefined = serializeError(err)
    while (node?.cause) {
      depth++
      node = node.cause as { cause?: unknown }
    }
    expect(depth).toBeLessThanOrEqual(5)
  })

  it('serialises AggregateError.errors', () => {
    const agg = new AggregateError([new Error('one'), new Error('two')], 'multiple failures')
    const serialized = serializeError(agg)
    expect(serialized.errors).toHaveLength(2)
    expect(serialized.errors?.[0]).toMatchObject({ name: 'Error', message: 'one' })
    expect(serialized.errors?.[1]).toMatchObject({ name: 'Error', message: 'two' })
  })

  it('does not crash on a non-Error throw and describes it structurally', () => {
    expect(serializeError('boom')).toEqual({ name: 'string', message: 'boom' })
    expect(serializeError(42)).toEqual({ name: 'number', message: '42' })
    expect(serializeError(undefined)).toEqual({ name: 'undefined', message: 'undefined' })
    expect(serializeError({ code: 'x' })).toEqual({ name: 'object', message: '[object Object]' })
  })
})
