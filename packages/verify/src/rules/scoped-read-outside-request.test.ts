import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { scopedReadOutsideRequest } from './scoped-read-outside-request'

const SCOPED = new Set(['currentUser', 'tenantId'])

function project(text: string, scoped: ReadonlySet<string> | null = SCOPED): Project {
  const relPath = 'src/modules/users/users.route.ts'
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null, scopedKeys: scoped }
}

describe('kata/scoped-read-outside-request', () => {
  it('flags a scoped read at module load (top level)', () => {
    const issues = scopedReadOutsideRequest.check(project("const u = c.get('currentUser')"))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/scoped-read-outside-request')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain("c.get('currentUser')")
    expect(issues[0]?.why).toContain('ADR-0004')
  })

  it('flags a scoped read in a free-standing helper function', () => {
    const issues = scopedReadOutsideRequest.check(
      project("export const load = (c) => c.get('tenantId')"),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('passes a scoped read inside a defineRoute handler', () => {
    const issues = scopedReadOutsideRequest.check(
      project(`export const r = defineRoute({
        method: 'GET',
        path: '/me',
        use: [requireUser],
        input: {},
        output: UserSchema,
        handler: async (c) => c.get('currentUser'),
      })`),
    )
    expect(issues).toEqual([])
  })

  it('passes a scoped read inside a defineMiddleware handler', () => {
    const issues = scopedReadOutsideRequest.check(
      project(`export const m = defineMiddleware({
        provides: ['tenantId'] as const,
        handler: async (c, next) => {
          const t = c.get('currentUser')
          c.set('tenantId', t.tenantId)
          await next()
        },
      })`),
    )
    expect(issues).toEqual([])
  })

  it('passes a scoped read in a callback the handler itself runs (nested, still in-request)', () => {
    const issues = scopedReadOutsideRequest.check(
      project(`export const r = defineRoute({
        method: 'GET',
        path: '/me',
        input: {},
        output: UserSchema,
        handler: async (c) => [1, 2].map(() => c.get('currentUser')),
      })`),
    )
    expect(issues).toEqual([])
  })

  it('passes a handler written as a method shorthand', () => {
    const issues = scopedReadOutsideRequest.check(
      project(`export const r = defineRoute({
        method: 'GET',
        path: '/me',
        input: {},
        output: UserSchema,
        handler(c) { return c.get('currentUser') },
      })`),
    )
    expect(issues).toEqual([])
  })

  it('ignores a singleton (non-scoped) key read outside a handler', () => {
    expect(scopedReadOutsideRequest.check(project("const log = c.get('logger')"))).toEqual([])
  })

  it('ignores a non-c receiver whose key coincides with a slot name', () => {
    expect(scopedReadOutsideRequest.check(project("const u = store.get('currentUser')"))).toEqual(
      [],
    )
  })

  it('bails when the scoped-key set is indeterminate (null)', () => {
    expect(scopedReadOutsideRequest.check(project("const u = c.get('currentUser')", null))).toEqual(
      [],
    )
  })

  it('bails when there are no scoped slots', () => {
    expect(
      scopedReadOutsideRequest.check(project("const u = c.get('currentUser')", new Set())),
    ).toEqual([])
  })

  it('reports the line of the offending read', () => {
    expect(
      scopedReadOutsideRequest.check(project("\n\nconst u = c.get('currentUser')"))[0]?.line,
    ).toBe(3)
  })
})
