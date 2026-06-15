import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { scopedSlotNotProvided } from './scoped-slot-not-provided'

function project(
  files: { relPath: string; text: string }[],
  scopedKeys: ReadonlySet<string> | null,
): Project {
  const sources: SourceFile[] = files.map((f) => ({
    path: `/repo/${f.relPath}`,
    relPath: f.relPath,
    text: f.text,
  }))
  return { root: '/repo', files: sources, registryKeys: null, scopedKeys }
}

const ROUTE = 'src/modules/users/users.route.ts'

/** A providing middleware in its own file (`auth` provides `currentUser`). */
const AUTH_MW = {
  relPath: 'src/middlewares/auth.ts',
  text: `export const auth = defineMiddleware({
    provides: ['currentUser'] as const,
    handler: async (c, next) => { c.set('currentUser', 1); await next() },
  })`,
}

function routeProject(routeText: string, scoped: ReadonlySet<string>, withAuth = true): Project {
  const files = withAuth
    ? [AUTH_MW, { relPath: ROUTE, text: routeText }]
    : [{ relPath: ROUTE, text: routeText }]
  return project(files, scoped)
}

/** A `src/main.ts` whose `createApp` declares the given `middlewares:` array literal. */
function appWith(middlewares: string): { relPath: string; text: string } {
  return {
    relPath: 'src/main.ts',
    text: `const app = createApp({ modules: [], middlewares: ${middlewares} })`,
  }
}

/** A route reading `currentUser` with no `use:` chain — provided only via the global chain, if at all. */
const READS_CURRENT_USER = {
  relPath: ROUTE,
  text: `export const me = defineRoute({
    method: 'GET', path: '/me', input: {}, output: U,
    handler: (c) => c.get('currentUser'),
  })`,
}

describe('kata/scoped-slot-not-provided', () => {
  it('passes a scoped read whose slot is provided by a use: middleware', () => {
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', use: [auth], input: {}, output: U,
        handler: (c) => c.get('currentUser'),
      })`,
      new Set(['currentUser']),
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('flags a scoped read with no use: chain at all', () => {
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', input: {}, output: U,
        handler: (c) => c.get('currentUser'),
      })`,
      new Set(['currentUser']),
      false,
    )
    const issues = scopedSlotNotProvided.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/scoped-slot-not-provided')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain("c.get('currentUser')")
    expect(issues[0]?.why).toContain('ADR-0004')
    expect(issues[0]?.fix).toContain('currentUser')
  })

  it('flags a scoped read when the use: middleware provides a different slot', () => {
    const other = {
      relPath: 'src/middlewares/other.ts',
      text: `export const other = defineMiddleware({
        provides: ['tenantId'] as const,
        handler: (c, next) => { c.set('tenantId', 1); return next() },
      })`,
    }
    const route = {
      relPath: ROUTE,
      text: `export const me = defineRoute({
        method: 'GET', path: '/me', use: [other], input: {}, output: U,
        handler: (c) => c.get('currentUser'),
      })`,
    }
    const p = project([other, route], new Set(['currentUser', 'tenantId']))
    expect(scopedSlotNotProvided.check(p)).toHaveLength(1)
  })

  it('ignores reads of a singleton key (only scoped slots need a provider)', () => {
    // `logger` is not in the scoped set, so reading it without a middleware is fine.
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', input: {}, output: U,
        handler: (c) => c.get('logger'),
      })`,
      new Set(['currentUser']),
      false,
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('resolves the handler context parameter by name (not hardcoded `c`)', () => {
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', use: [auth], input: {}, output: U,
        handler: (ctx) => ctx.get('currentUser'),
      })`,
      new Set(['currentUser']),
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('reports each unprovided scoped slot once, and only the unprovided one', () => {
    // auth provides currentUser; tenantId is read but never provided.
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', use: [auth], input: {}, output: U,
        handler: (c) => {
          const a = c.get('currentUser')
          const b = c.get('tenantId')
          const again = c.get('tenantId')
          return { a, b, again }
        },
      })`,
      new Set(['currentUser', 'tenantId']),
    )
    const issues = scopedSlotNotProvided.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('bails when the scoped-key set is indeterminate (null)', () => {
    const p = project(
      [
        {
          relPath: ROUTE,
          text: `export const me = defineRoute({
            method: 'GET', path: '/me', input: {}, output: U,
            handler: (c) => c.get('currentUser'),
          })`,
        },
      ],
      null,
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when a use: entry is an unresolvable factory call (cors())', () => {
    // cors() might provide anything as far as static analysis can prove → no flag.
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', use: [cors()], input: {}, output: U,
        handler: (c) => c.get('currentUser'),
      })`,
      new Set(['currentUser']),
      false,
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when the use: chain contains a spread', () => {
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', use: [...shared], input: {}, output: U,
        handler: (c) => c.get('currentUser'),
      })`,
      new Set(['currentUser']),
      false,
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when the handler context parameter is destructured', () => {
    const p = routeProject(
      `export const me = defineRoute({
        method: 'GET', path: '/me', input: {}, output: U,
        handler: ({ get }) => get('currentUser'),
      })`,
      new Set(['currentUser']),
      false,
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('only inspects *.route.ts files', () => {
    const p = project(
      [
        {
          relPath: 'src/modules/users/users.service.ts',
          text: "export const f = (c) => c.get('currentUser')",
        },
      ],
      new Set(['currentUser']),
    )
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('reports the line of the offending read', () => {
    const p = routeProject(
      `export const me = defineRoute({
  method: 'GET',
  path: '/me',
  input: {},
  output: U,
  handler: (c) => c.get('currentUser'),
})`,
      new Set(['currentUser']),
      false,
    )
    expect(scopedSlotNotProvided.check(p)[0]?.line).toBe(6)
  })

  // ── ADR-0012: app-level (`createApp({ middlewares })`) providers ───────────

  it('does not flag a read provided by an app-level middleware, even with no use: chain', () => {
    const p = project([AUTH_MW, appWith('[auth]'), READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('still flags a read provided by neither the app-level chain nor use:', () => {
    // The global chain provides currentUser; the route reads tenantId, which nothing provides.
    const route = {
      relPath: ROUTE,
      text: `export const me = defineRoute({
        method: 'GET', path: '/me', input: {}, output: U,
        handler: (c) => c.get('tenantId'),
      })`,
    }
    const p = project([AUTH_MW, appWith('[auth]'), route], new Set(['currentUser', 'tenantId']))
    const issues = scopedSlotNotProvided.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('reads app-level providers from a namespaced k.createApp call', () => {
    const main = {
      relPath: 'src/main.ts',
      text: `const app = k.createApp({ modules: [], middlewares: [auth] })`,
    }
    const p = project([AUTH_MW, main, READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when an app-level middlewares entry is an unresolvable factory call', () => {
    // secureHeaders() might provide anything as far as static analysis can prove → no flag, app-wide.
    const p = project([appWith('[secureHeaders()]'), READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when the app-level middlewares chain contains a spread', () => {
    const p = project([appWith('[...shared]'), READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when the app-level middlewares value is not an array literal', () => {
    const p = project([appWith('sharedGlobals'), READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when the createApp config carries an object spread that could inject middlewares', () => {
    const main = { relPath: 'src/main.ts', text: `const app = createApp({ ...base, modules: [] })` }
    const p = project([main, READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('bails when the createApp config is not an object literal', () => {
    const main = { relPath: 'src/main.ts', text: `const app = createApp(buildConfig())` }
    const p = project([main, READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toEqual([])
  })

  it('a createApp without a middlewares chain leaves routes checked as before', () => {
    // Guard: the mere presence of createApp must not be treated as a global provider.
    const main = { relPath: 'src/main.ts', text: `const app = createApp({ modules: [] })` }
    const p = project([main, READS_CURRENT_USER], new Set(['currentUser']))
    expect(scopedSlotNotProvided.check(p)).toHaveLength(1)
  })
})
