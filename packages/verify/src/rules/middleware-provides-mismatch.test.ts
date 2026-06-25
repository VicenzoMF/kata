import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { middlewareProvidesMismatch } from './middleware-provides-mismatch'

function mwFile(text: string, relPath = 'src/middlewares/auth.ts'): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

describe('kata/middleware-provides-mismatch', () => {
  it('passes when every provided key is set', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async (c, next) => {
          c.set('currentUser', await getUser(c))
          await next()
        },
      })
    `)
    expect(middlewareProvidesMismatch.check(p)).toEqual([])
  })

  it('flags a provided key the handler never sets', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser', 'tenantId'] as const,
        handler: async (c, next) => {
          c.set('currentUser', await getUser(c))
          await next()
        },
      })
    `)
    const issues = middlewareProvidesMismatch.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/middleware-provides-mismatch')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('tenantId')
    expect(issues[0]?.why).toContain('ADR-0004')
  })

  it('works without `as const` on the provides array', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'],
        handler: (c, next) => { return next() },
      })
    `)
    expect(middlewareProvidesMismatch.check(p)).toHaveLength(1)
  })

  it('resolves the handler context parameter by name (not hardcoded `c`)', () => {
    // Using `ctx` instead of `c` must NOT trigger a false positive.
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async (ctx, next) => {
          ctx.set('currentUser', await getUser(ctx))
          await next()
        },
      })
    `)
    expect(middlewareProvidesMismatch.check(p)).toEqual([])
  })

  it('supports a method-shorthand handler', () => {
    const ok = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler(c, next) { c.set('currentUser', 1) },
      })
    `)
    expect(middlewareProvidesMismatch.check(ok)).toEqual([])

    const bad = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler(c, next) { return next() },
      })
    `)
    expect(middlewareProvidesMismatch.check(bad)).toHaveLength(1)
  })

  it('bails when the handler sets a dynamic (non-literal) key', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async (c, next) => {
          c.set(slotKey, value)
          await next()
        },
      })
    `)
    expect(middlewareProvidesMismatch.check(p)).toEqual([])
  })

  it('bails when the context parameter is destructured', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async ({ set }, next) => {
          set('currentUser', 1)
          await next()
        },
      })
    `)
    expect(middlewareProvidesMismatch.check(p)).toEqual([])
  })

  it('bails when the handler is missing or not a function literal', () => {
    expect(
      middlewareProvidesMismatch.check(mwFile("defineMiddleware({ provides: ['x'] })")),
    ).toEqual([])
    expect(
      middlewareProvidesMismatch.check(
        mwFile("defineMiddleware({ provides: ['x'], handler: someExternalHandler })"),
      ),
    ).toEqual([])
  })

  it('bails on a spread config', () => {
    const p = mwFile("export const a = defineMiddleware({ ...base, provides: ['x'] })")
    expect(middlewareProvidesMismatch.check(p)).toEqual([])
  })

  it('checks each middleware independently in a file', () => {
    const p = mwFile(`
      export const ok = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: (c, next) => { c.set('currentUser', 1); return next() },
      })
      export const broken = defineMiddleware({
        provides: ['tenantId'] as const,
        handler: (c, next) => next(),
      })
    `)
    const issues = middlewareProvidesMismatch.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('tenantId')
  })

  it('warns (does not error) when the handler sets a key not listed in provides', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async (c, next) => {
          c.set('currentUser', await getUser(c))
          c.set('tenantId', 1)
          await next()
        },
      })
    `)
    const issues = middlewareProvidesMismatch.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/middleware-provides-mismatch')
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.message).toContain('tenantId')
    expect(issues[0]?.message).toContain('not listed in its provides')
    expect(issues[0]?.why).toContain('ADR-0004')
    // Reported at the offending `c.set` call, not the provides entry.
    expect(issues[0]?.line).toBe(6)
  })

  it('reports both a missing-set error and an over-provide warning together', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async (c, next) => {
          c.set('tenantId', 1)
          await next()
        },
      })
    `)
    const issues = middlewareProvidesMismatch.check(p)
    expect(issues).toHaveLength(2)
    const error = issues.find((i) => i.severity === 'error')
    const warning = issues.find((i) => i.severity === 'warning')
    expect(error?.message).toContain('currentUser')
    expect(warning?.message).toContain('tenantId')
  })

  it('does not warn when every set key is also provided', () => {
    const p = mwFile(`
      export const auth = defineMiddleware({
        provides: ['currentUser', 'tenantId'] as const,
        handler: async (c, next) => {
          c.set('currentUser', await getUser(c))
          c.set('tenantId', 1)
          await next()
        },
      })
    `)
    expect(middlewareProvidesMismatch.check(p)).toEqual([])
  })

  it('ignores files with no defineMiddleware call', () => {
    expect(middlewareProvidesMismatch.check(mwFile('export const x = 1'))).toEqual([])
  })

  it('reports the line of the offending provides entry', () => {
    const p = mwFile(`export const a = defineMiddleware({
  provides: ['tenantId'],
  handler: (c, next) => next(),
})`)
    expect(middlewareProvidesMismatch.check(p)[0]?.line).toBe(2)
  })
})
