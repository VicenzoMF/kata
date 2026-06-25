import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { noAdhocErrorShape } from './no-adhoc-error-shape'

function fileProject(text: string, relPath = 'src/modules/users/users.route.ts'): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

describe('kata/no-adhoc-error-shape', () => {
  it('flags an inline c.json({ error }, 400)', () => {
    const issues = noAdhocErrorShape.check(fileProject("return c.json({ error: 'x' }, 400)"))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/no-adhoc-error-shape')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('400')
    expect(issues[0]?.why).toContain('ADR-0008')
    expect(issues[0]?.fix).toContain('c.error(')
  })

  it('flags a 5xx error shape too', () => {
    const issues = noAdhocErrorShape.check(
      fileProject("return c.json({ error: 'internal_error' }, 500)"),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('500')
  })

  it('flags at both ends of the 4xx–5xx range', () => {
    expect(noAdhocErrorShape.check(fileProject("c.json({ error: 'e' }, 400)"))).toHaveLength(1)
    expect(noAdhocErrorShape.check(fileProject("c.json({ error: 'e' }, 599)"))).toHaveLength(1)
  })

  it('flags an error shape carrying extra fields (e.g. issues)', () => {
    const issues = noAdhocErrorShape.check(
      fileProject("return c.json({ error: 'validation_failed', issues }, 422)"),
    )
    expect(issues).toHaveLength(1)
  })

  it('passes a c.error(...) call (the sanctioned helper)', () => {
    const issues = noAdhocErrorShape.check(
      fileProject("return c.error('not_found', 'User not found', { status: 404 })"),
    )
    expect(issues).toEqual([])
  })

  it('passes a success body c.json(body, 200)', () => {
    const issues = noAdhocErrorShape.check(fileProject('return c.json(user, 200)'))
    expect(issues).toEqual([])
  })

  it('passes a success object literal even if 2xx', () => {
    const issues = noAdhocErrorShape.check(fileProject('return c.json({ ok: true }, 201)'))
    expect(issues).toEqual([])
  })

  it('ignores an object literal without an error property at a 4xx status', () => {
    const issues = noAdhocErrorShape.check(fileProject("return c.json({ message: 'nope' }, 404)"))
    expect(issues).toEqual([])
  })

  it('ignores an error body returned with a 2xx/3xx status', () => {
    expect(noAdhocErrorShape.check(fileProject("c.json({ error: 'x' }, 200)"))).toEqual([])
    expect(noAdhocErrorShape.check(fileProject("c.json({ error: 'x' }, 302)"))).toEqual([])
  })

  it('ignores a non-numeric / dynamic status', () => {
    const issues = noAdhocErrorShape.check(fileProject("c.json({ error: 'x' }, status)"))
    expect(issues).toEqual([])
  })

  it('ignores a spread body (could inject or omit error — bail to avoid false positives)', () => {
    const issues = noAdhocErrorShape.check(fileProject('c.json({ ...base }, 400)'))
    expect(issues).toEqual([])
  })

  it('ignores .json on a non-context receiver', () => {
    const issues = noAdhocErrorShape.check(fileProject("res.json({ error: 'x' }, 400)"))
    expect(issues).toEqual([])
  })

  it('ignores a single-argument c.json call', () => {
    const issues = noAdhocErrorShape.check(fileProject("c.json({ error: 'x' })"))
    expect(issues).toEqual([])
  })

  it('reports the line of the offending call', () => {
    const issues = noAdhocErrorShape.check(fileProject("\n\nreturn c.json({ error: 'x' }, 400)"))
    expect(issues[0]?.line).toBe(3)
  })
})
