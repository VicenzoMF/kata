import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { noRouteWithoutOutputSchema } from './no-route-without-output-schema'

function routeFile(text: string, relPath = 'src/modules/users/users.route.ts'): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

describe('kata/no-route-without-output-schema', () => {
  it('passes a route that declares output', () => {
    const project = routeFile(`
      export const r = defineRoute({
        method: 'GET',
        path: '/users/:id',
        input: { params: z.object({ id: z.string() }) },
        output: UserSchema,
        handler: async (c) => getUser(c.input.params.id),
      })
    `)
    expect(noRouteWithoutOutputSchema.check(project)).toEqual([])
  })

  it('flags a route missing output', () => {
    const project = routeFile(`
      export const r = defineRoute({
        method: 'GET',
        path: '/users/:id',
        input: { params: z.object({ id: z.string() }) },
        handler: async (c) => getUser(c.input.params.id),
      })
    `)
    const issues = noRouteWithoutOutputSchema.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/no-route-without-output-schema')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.file).toBe('src/modules/users/users.route.ts')
    expect(issues[0]?.message).toContain('output')
    expect(issues[0]?.why).toContain('ADR-0003')
  })

  it('reports each offending route once', () => {
    const project = routeFile(`
      export const a = defineRoute({ method: 'GET', path: '/a', input: {}, handler: () => null })
      export const b = defineRoute({ method: 'GET', path: '/b', input: {}, output: S, handler: () => null })
      export const c = defineRoute({ method: 'GET', path: '/c', input: {}, handler: () => null })
    `)
    const issues = noRouteWithoutOutputSchema.check(project)
    expect(issues).toHaveLength(2)
  })

  it('skips a defineRoute whose config is spread (output cannot be proven absent)', () => {
    const project = routeFile(`
      export const r = defineRoute({ ...base, method: 'GET', path: '/x', input: {} })
    `)
    expect(noRouteWithoutOutputSchema.check(project)).toEqual([])
  })

  it('skips a defineRoute whose argument is not an object literal', () => {
    const project = routeFile('export const r = defineRoute(config)')
    expect(noRouteWithoutOutputSchema.check(project)).toEqual([])
  })

  it('ignores files that are not *.route.ts', () => {
    const project = routeFile(
      'export const r = defineRoute({ method: "GET", path: "/x", input: {}, handler: () => null })',
      'src/modules/users/users.service.ts',
    )
    expect(noRouteWithoutOutputSchema.check(project)).toEqual([])
  })
})
