import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { inlineSchema } from './inline-schema'

function fileProject(text: string, relPath: string): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

const ROUTE = 'src/modules/users/users.route.ts'
const SERVICE = 'src/modules/users/users.service.ts'

describe('kata/inline-schema', () => {
  it('flags an inline z.object in a route file', () => {
    const p = fileProject('export const S = z.object({ id: z.string() })', ROUTE)
    const issues = inlineSchema.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/inline-schema')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('z.object(...)')
    expect(issues[0]?.message).toContain('users.schema.ts')
    expect(issues[0]?.why).toContain('ADR-0005')
    expect(issues[0]?.fix).toContain('users.schema.ts')
  })

  it('flags an inline schema in a service file', () => {
    const p = fileProject('const Parsed = z.string().parse(raw)', SERVICE)
    const issues = inlineSchema.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('z.string(...)')
  })

  it('reports a nested construction once (outermost only)', () => {
    // z.object wraps z.string() + z.array(z.string()): one inline schema, one issue.
    const p = fileProject(
      'export const S = z.object({ id: z.string(), tags: z.array(z.string()) })',
      ROUTE,
    )
    expect(inlineSchema.check(p)).toHaveLength(1)
  })

  it('reports a method chain once (at the chain root)', () => {
    // z.string().email().min(3) is one chain rooted at z.string().
    const p = fileProject('export const S = z.string().email().min(3)', ROUTE)
    expect(inlineSchema.check(p)).toHaveLength(1)
  })

  it('reports each independent inline schema', () => {
    const p = fileProject(
      `export const r = defineRoute({
        method: 'GET',
        path: '/users/:id',
        input: { params: z.object({ id: z.string() }) },
        output: z.object({ ok: z.literal(true) }),
        handler: () => null,
      })`,
      ROUTE,
    )
    // Two independent z.object roots (input.params and output) → two issues.
    expect(inlineSchema.check(p)).toHaveLength(2)
  })

  it('passes a route that imports its schemas by name', () => {
    const p = fileProject(
      `import { UserSchema, CreateUserBodySchema } from './users.schema'
       export const r = defineRoute({
         method: 'POST',
         path: '/users',
         input: { body: CreateUserBodySchema },
         output: UserSchema,
         handler: async (c) => createUser(c.input.body),
       })`,
      ROUTE,
    )
    expect(inlineSchema.check(p)).toEqual([])
  })

  it('allows inline schemas in *.schema.ts (never guarded)', () => {
    const p = fileProject(
      'export const UserSchema = z.object({ id: z.string() })',
      'src/modules/users/users.schema.ts',
    )
    expect(inlineSchema.check(p)).toEqual([])
  })

  it('ignores a non-route/service file (e.g. context.ts)', () => {
    const p = fileProject('export const S = z.object({ id: z.string() })', 'src/context.ts')
    expect(inlineSchema.check(p)).toEqual([])
  })

  it('does not match .get/.set or other non-z chained calls', () => {
    const p = fileProject("const u = c.get('currentUser'); const v = cache.object()", ROUTE)
    expect(inlineSchema.check(p)).toEqual([])
  })

  it('reports the line of the offending construction', () => {
    const p = fileProject('\n\nexport const S = z.object({})', ROUTE)
    expect(inlineSchema.check(p)[0]?.line).toBe(3)
  })
})
