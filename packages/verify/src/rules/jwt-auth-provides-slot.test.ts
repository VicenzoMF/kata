import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { jwtAuthProvidesSlot } from './jwt-auth-provides-slot'

function mwFile(text: string, relPath = 'src/middlewares/auth.ts'): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

describe('kata/jwt-auth-provides-slot', () => {
  it('passes when provides lists the explicit slot', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['user'] as const,
        handler: jwtAuth({ secret, claims, slot: 'user' }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('flags a jwtAuth slot missing from provides', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['tenantId'] as const,
        handler: jwtAuth({ secret, claims, slot: 'user' }),
      })
    `)
    const issues = jwtAuthProvidesSlot.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/jwt-auth-provides-slot')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('user')
    expect(issues[0]?.why).toContain('ADR-0013')
  })

  it('flags a jwtAuth handler with no provides at all', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        handler: jwtAuth({ secret, claims, slot: 'user' }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toHaveLength(1)
  })

  it("defaults the slot to 'currentUser' when omitted", () => {
    const bad = mwFile(`
      export const auth = defineMiddleware({
        provides: [] as const,
        handler: jwtAuth({ secret, claims }),
      })
    `)
    const issues = jwtAuthProvidesSlot.check(bad)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('currentUser')

    const ok = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: jwtAuth({ secret, claims }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(ok)).toEqual([])
  })

  it('works without `as const` on the provides array', () => {
    expect(
      jwtAuthProvidesSlot.check(
        mwFile(`
          export const auth = defineMiddleware({
            provides: ['user'],
            handler: jwtAuth({ secret, claims, slot: 'user' }),
          })
        `),
      ),
    ).toEqual([])
    expect(
      jwtAuthProvidesSlot.check(
        mwFile(`
          export const auth = defineMiddleware({
            provides: ['tenantId'],
            handler: jwtAuth({ secret, claims, slot: 'user' }),
          })
        `),
      ),
    ).toHaveLength(1)
  })

  it('supports the namespaced k.jwtAuth(...) call style', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['tenantId'] as const,
        handler: jwt.jwtAuth({ secret, claims, slot: 'user' }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toHaveLength(1)
  })

  it('ignores a non-jwtAuth handler (left to other rules)', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['user'] as const,
        handler: async (c, next) => { await next() },
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('ignores a guard handler (a guard provides nothing, ADR-0013)', () => {
    const p = mwFile(`
      export const onlyAdmins = defineMiddleware({
        provides: [] as const,
        handler: guard({ slot: 'currentUser', authorize: (u) => u.role === 'admin' }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('bails when the jwtAuth slot is a non-literal (dynamic) value', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['user'] as const,
        handler: jwtAuth({ secret, claims, slot: slotName }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('bails when the jwtAuth options is not an object literal', () => {
    expect(
      jwtAuthProvidesSlot.check(
        mwFile("defineMiddleware({ provides: ['user'], handler: jwtAuth(opts) })"),
      ),
    ).toEqual([])
  })

  it('bails when the jwtAuth options is spread', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['user'] as const,
        handler: jwtAuth({ ...base, slot: 'user' }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('bails when provides is not an array literal', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: someProvides,
        handler: jwtAuth({ secret, claims, slot: 'user' }),
      })
    `)
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('bails on a spread config', () => {
    const p = mwFile(
      "export const a = defineMiddleware({ ...base, handler: jwtAuth({ slot: 'user' }) })",
    )
    expect(jwtAuthProvidesSlot.check(p)).toEqual([])
  })

  it('checks each middleware independently in a file', () => {
    const p = mwFile(`
      export const ok = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: jwtAuth({ secret, claims }),
      })
      export const broken = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: jwtAuth({ secret, claims, slot: 'user' }),
      })
    `)
    const issues = jwtAuthProvidesSlot.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('user')
  })

  it('reports the line of the offending jwtAuth handler', () => {
    const p = mwFile(`export const a = defineMiddleware({
  provides: ['tenantId'],
  handler: jwtAuth({ secret, claims, slot: 'user' }),
})`)
    expect(jwtAuthProvidesSlot.check(p)[0]?.line).toBe(3)
  })

  it('ignores files with no defineMiddleware call', () => {
    expect(jwtAuthProvidesSlot.check(mwFile('export const x = 1'))).toEqual([])
  })
})
