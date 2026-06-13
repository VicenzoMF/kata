import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { noRouteWithoutInputSchema } from './no-route-without-input-schema'

function routeFile(text: string, relPath = 'src/modules/users/users.route.ts'): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

describe('kata/no-route-without-input-schema', () => {
  it('passes a route that declares input', () => {
    const project = routeFile(`
      export const r = defineRoute({
        method: 'POST',
        path: '/users',
        input: { body: CreateUserBodySchema },
        output: UserSchema,
        handler: async (c) => createUser(c.input.body),
      })
    `)
    expect(noRouteWithoutInputSchema.check(project)).toEqual([])
  })

  it('passes a route whose input is an empty object literal', () => {
    // ADR-0003 / issue #7: `input: {}` is explicit and valid; only a *missing*
    // input field is a violation.
    const project = routeFile(`
      export const r = defineRoute({
        method: 'GET',
        path: '/me',
        input: {},
        output: UserSchema,
        handler: async (c) => c.get('currentUser'),
      })
    `)
    expect(noRouteWithoutInputSchema.check(project)).toEqual([])
  })

  it('flags a route missing input', () => {
    const project = routeFile(`
      export const r = defineRoute({
        method: 'GET',
        path: '/health',
        output: HealthSchema,
        handler: () => ({ ok: true }),
      })
    `)
    const issues = noRouteWithoutInputSchema.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/no-route-without-input-schema')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.file).toBe('src/modules/users/users.route.ts')
    expect(issues[0]?.message).toContain('input')
    expect(issues[0]?.why).toContain('ADR-0003')
  })

  it('reports each offending route once', () => {
    const project = routeFile(`
      export const a = defineRoute({ method: 'GET', path: '/a', output: S, handler: () => null })
      export const b = defineRoute({ method: 'GET', path: '/b', input: {}, output: S, handler: () => null })
      export const c = defineRoute({ method: 'GET', path: '/c', output: S, handler: () => null })
    `)
    const issues = noRouteWithoutInputSchema.check(project)
    expect(issues).toHaveLength(2)
  })

  it('skips a defineRoute whose config is spread (input cannot be proven absent)', () => {
    const project = routeFile(`
      export const r = defineRoute({ ...base, method: 'GET', path: '/x', output: S })
    `)
    expect(noRouteWithoutInputSchema.check(project)).toEqual([])
  })

  it('skips a defineRoute whose argument is not an object literal', () => {
    const project = routeFile('export const r = defineRoute(config)')
    expect(noRouteWithoutInputSchema.check(project)).toEqual([])
  })

  it('ignores files that are not *.route.ts', () => {
    const project = routeFile(
      'export const r = defineRoute({ method: "GET", path: "/x", output: S, handler: () => null })',
      'src/modules/users/users.service.ts',
    )
    expect(noRouteWithoutInputSchema.check(project)).toEqual([])
  })
})
