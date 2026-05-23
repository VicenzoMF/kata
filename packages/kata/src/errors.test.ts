import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { formatZodIssues } from './errors'

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
