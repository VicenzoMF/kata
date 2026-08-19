import { describe, expect, it } from 'vitest'

import { createProject } from '../project'
import type { Issue, Project, ProvidesManifest, SourceFile, Suppression } from '../types'

import { scopedSlotNotProvided } from './scoped-slot-not-provided'

function project(
  files: { relPath: string; text: string }[],
  scopedKeys: ReadonlySet<string> | null,
  packageManifest: (name: string) => ProvidesManifest | null = () => null,
): Project {
  const sources: SourceFile[] = files.map((f) => ({
    path: `/repo/${f.relPath}`,
    relPath: f.relPath,
    text: f.text,
  }))
  return createProject({
    root: '/repo',
    files: sources,
    registryKeys: null,
    scopedKeys,
    packageManifest,
  })
}

const issuesOf = (p: Project): readonly Issue[] => scopedSlotNotProvided.check(p).issues
const suppressionsOf = (p: Project): readonly Suppression[] =>
  scopedSlotNotProvided.check(p).suppressions

const ROUTE = 'src/modules/users/users.route.ts'
const SCOPED = new Set(['currentUser', 'tenantId'])

/** A providing middleware in its own file (`auth` provides `currentUser`). */
const AUTH_MW = {
  relPath: 'src/middlewares/auth.ts',
  text: `export const auth = defineMiddleware({
    provides: ['currentUser'] as const,
    handler: async (c, next) => { c.set('currentUser', 1); await next() },
  })`,
}

/** The import a route needs for `auth` to resolve — resolution is module-aware. */
const IMPORT_AUTH = "import { auth } from '../../middlewares/auth'\n"

function route(body: string, imports = ''): { relPath: string; text: string } {
  return { relPath: ROUTE, text: `${imports}export const me = defineRoute({\n${body}\n})` }
}

/** A `src/main.ts` whose `createApp` declares the given `middlewares:` array literal. */
function appWith(middlewares: string, imports = ''): { relPath: string; text: string } {
  return {
    relPath: 'src/main.ts',
    text: `${imports}const app = createApp({ modules: [], middlewares: ${middlewares} })`,
  }
}

/** A route reading `currentUser` with no `use:` chain — provided only via the global chain, if at all. */
const READS_CURRENT_USER = route(`  method: 'GET', path: '/me', input: {}, output: U,
  handler: (c) => c.get('currentUser'),`)

describe('kata/scoped-slot-not-provided', () => {
  it('passes a scoped read whose slot is provided by a use: middleware', () => {
    const p = project(
      [
        AUTH_MW,
        route(
          `  method: 'GET', path: '/me', use: [auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          IMPORT_AUTH,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('flags a scoped read with no use: chain at all', () => {
    const p = project([READS_CURRENT_USER], SCOPED)
    const issues = issuesOf(p)
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
    const p = project(
      [
        other,
        route(
          `  method: 'GET', path: '/me', use: [other], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { other } from '../../middlewares/other'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toHaveLength(1)
  })

  it('ignores reads of a singleton key (only scoped slots need a provider)', () => {
    // `logger` is not in the scoped set, so reading it without a middleware is fine.
    const p = project(
      [
        route(`  method: 'GET', path: '/me', input: {}, output: U,
  handler: (c) => c.get('logger'),`),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('resolves the handler context parameter by name (not hardcoded `c`)', () => {
    const p = project(
      [
        AUTH_MW,
        route(
          `  method: 'GET', path: '/me', use: [auth], input: {}, output: U,
  handler: (ctx) => ctx.get('currentUser'),`,
          IMPORT_AUTH,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('reports every unprovided read, and only the unprovided ones', () => {
    const p = project(
      [
        AUTH_MW,
        route(
          `  method: 'GET', path: '/me', use: [auth], input: {}, output: U,
  handler: (c) => {
    const a = c.get('currentUser')
    const b = c.get('tenantId')
    const again = c.get('tenantId')
    return { a, b, again }
  },`,
          IMPORT_AUTH,
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(2)
    expect(issues.every((issue) => issue.message.includes("c.get('tenantId')"))).toBe(true)
  })

  it('reports the line of the offending read', () => {
    const p = project(
      [
        {
          relPath: ROUTE,
          text: `export const me = defineRoute({
  method: 'GET',
  path: '/me',
  input: {},
  output: U,
  handler: (c) => c.get('currentUser'),
})`,
        },
      ],
      SCOPED,
    )
    expect(issuesOf(p)[0]?.line).toBe(6)
  })

  it('does not report reads outside a defineRoute handler (another rule owns those)', () => {
    const p = project(
      [
        {
          relPath: 'src/modules/users/users.service.ts',
          text: "export const f = (c) => c.get('currentUser')",
        },
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  // ── module-aware resolution (issue #206 part 1) ────────────────────────────

  it('resolves a middleware declared in the route file itself', () => {
    const p = project(
      [
        {
          relPath: ROUTE,
          text: `const local = defineMiddleware({
            provides: ['currentUser'] as const,
            handler: (c, next) => { c.set('currentUser', 1); return next() },
          })
          export const me = defineRoute({
            method: 'GET', path: '/me', use: [local], input: {}, output: U,
            handler: (c) => c.get('currentUser'),
          })`,
        },
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('follows an import written with the ESM .js extension', () => {
    const p = project(
      [
        AUTH_MW,
        route(
          `  method: 'GET', path: '/me', use: [auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { auth } from '../../middlewares/auth.js'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('follows an aliased import to the middleware it renames', () => {
    const p = project(
      [
        AUTH_MW,
        route(
          `  method: 'GET', path: '/me', use: [guard], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { auth as guard } from '../../middlewares/auth'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('follows a namespace import (`mw.auth`)', () => {
    const p = project(
      [
        AUTH_MW,
        route(
          `  method: 'GET', path: '/me', use: [mw.auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import * as mw from '../../middlewares/auth'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('follows a barrel re-export', () => {
    const barrel = {
      relPath: 'src/middlewares/index.ts',
      text: "export { auth } from './auth'",
    }
    const p = project(
      [
        AUTH_MW,
        barrel,
        route(
          `  method: 'GET', path: '/me', use: [auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { auth } from '../../middlewares'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('does not union the provides of same-named middlewares in different modules', () => {
    // Both files export `authenticate`; only the *imported* one counts.
    const userAuth = {
      relPath: 'src/middlewares/user-auth.ts',
      text: `export const authenticate = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: (c, next) => { c.set('currentUser', 1); return next() },
      })`,
    }
    const tenantAuth = {
      relPath: 'src/middlewares/tenant-auth.ts',
      text: `export const authenticate = defineMiddleware({
        provides: ['tenantId'] as const,
        handler: (c, next) => { c.set('tenantId', 1); return next() },
      })`,
    }
    const p = project(
      [
        userAuth,
        tenantAuth,
        route(
          `  method: 'GET', path: '/me', use: [authenticate], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { authenticate } from '../../middlewares/tenant-auth'\n",
        ),
      ],
      SCOPED,
    )
    // tenant-auth's `authenticate` provides tenantId, not currentUser.
    expect(issuesOf(p)).toHaveLength(1)
  })

  it('resolves an in-project factory call to the middleware it returns', () => {
    const factory = {
      relPath: 'src/middlewares/require-role.ts',
      text: `export function requireRole(role) {
        return defineMiddleware({
          provides: ['currentUser'] as const,
          handler: (c, next) => { c.set('currentUser', role); return next() },
        })
      }`,
    }
    const p = project(
      [
        factory,
        route(
          `  method: 'GET', path: '/me', use: [requireRole('admin')], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { requireRole } from '../../middlewares/require-role'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('resolves a package middleware through its provides.json manifest', () => {
    const manifest: ProvidesManifest = {
      version: 1,
      exports: { '.': { cors: { provides: [] } } },
    }
    const p = project(
      [appWith('[cors()]', "import { cors } from 'katajs'\n"), READS_CURRENT_USER],
      SCOPED,
      (name) => (name === 'katajs' ? manifest : null),
    )
    // cors() resolves to `provides: []`, so the read is *disproved* rather than skipped.
    expect(issuesOf(p)).toHaveLength(1)
    expect(suppressionsOf(p)).toEqual([])
  })

  it('resolves a manifest middleware that does provide the slot', () => {
    const manifest: ProvidesManifest = {
      version: 1,
      exports: { './auth': { session: { provides: ['currentUser'] } } },
    }
    const p = project(
      [appWith('[session()]', "import { session } from 'some-pkg/auth'\n"), READS_CURRENT_USER],
      SCOPED,
      (name) => (name === 'some-pkg' ? manifest : null),
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  // ── chain order (issue #206 part 3) ────────────────────────────────────────

  /** Reads `currentUser` before calling `next()`; provides `tenantId`. */
  const MEMBERSHIP_MW = {
    relPath: 'src/middlewares/membership.ts',
    text: `export const resolveMembership = defineMiddleware({
      provides: ['tenantId'] as const,
      handler: async (c, next) => {
        const user = c.get('currentUser')
        c.set('tenantId', user.tenantId)
        await next()
      },
    })`,
  }

  const IMPORT_BOTH = `${IMPORT_AUTH}import { resolveMembership } from '../../middlewares/membership'\n`

  it('passes a middleware whose slot is provided earlier in the chain', () => {
    const p = project(
      [
        AUTH_MW,
        MEMBERSHIP_MW,
        route(
          `  method: 'GET', path: '/me', use: [auth, resolveMembership], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          IMPORT_BOTH,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('flags a use: chain whose order is wrong', () => {
    const p = project(
      [
        AUTH_MW,
        MEMBERSHIP_MW,
        route(
          `  method: 'GET', path: '/me', use: [resolveMembership, auth], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          IMPORT_BOTH,
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('resolveMembership')
    expect(issues[0]?.message).toContain("c.get('currentUser')")
    expect(issues[0]?.file).toBe(ROUTE) // reported at the use: entry, where the fix goes
    expect(issues[0]?.fix).toContain('use:')
  })

  it('flags a middleware reading a slot nothing in the chain provides', () => {
    const p = project(
      [
        MEMBERSHIP_MW,
        route(
          `  method: 'GET', path: '/me', use: [resolveMembership], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          "import { resolveMembership } from '../../middlewares/membership'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toHaveLength(1)
  })

  it('counts the app-level chain as running before the route use: chain', () => {
    const p = project(
      [
        AUTH_MW,
        MEMBERSHIP_MW,
        appWith('[auth]', "import { auth } from './middlewares/auth'\n"),
        route(
          `  method: 'GET', path: '/me', use: [resolveMembership], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          "import { resolveMembership } from '../../middlewares/membership'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('allows a middleware to read a slot it sets itself', () => {
    const selfish = {
      relPath: 'src/middlewares/selfish.ts',
      text: `export const selfish = defineMiddleware({
        provides: ['currentUser'] as const,
        handler: async (c, next) => {
          c.set('currentUser', 1)
          c.get('currentUser')
          await next()
        },
      })`,
    }
    const p = project(
      [
        selfish,
        route(
          `  method: 'GET', path: '/me', use: [selfish], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          "import { selfish } from '../../middlewares/selfish'\n",
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('allows a post-next() read of a slot a later middleware provides', () => {
    // An audit middleware that logs the user *after* the chain has run is fine:
    // `auth` set the slot by then, even though it comes later in `use:`.
    const audit = {
      relPath: 'src/middlewares/audit.ts',
      text: `export const audit = defineMiddleware({
        handler: async (c, next) => {
          await next()
          log(c.get('currentUser'))
        },
      })`,
    }
    const p = project(
      [
        AUTH_MW,
        audit,
        route(
          `  method: 'GET', path: '/me', use: [audit, auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          `${IMPORT_AUTH}import { audit } from '../../middlewares/audit'\n`,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('flags a post-next() read of a slot no middleware provides', () => {
    const audit = {
      relPath: 'src/middlewares/audit.ts',
      text: `export const audit = defineMiddleware({
        handler: async (c, next) => {
          await next()
          log(c.get('tenantId'))
        },
      })`,
    }
    const p = project(
      [
        audit,
        route(
          `  method: 'GET', path: '/me', use: [audit], input: {}, output: U,
  handler: (c) => 1,`,
          "import { audit } from '../../middlewares/audit'\n",
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('flags an app-level middleware reading a slot the global chain never provides', () => {
    const p = project(
      [
        MEMBERSHIP_MW,
        appWith(
          '[resolveMembership]',
          "import { resolveMembership } from './middlewares/membership'\n",
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.file).toBe('src/main.ts')
  })

  // ── suppressions (issue #206 part 2) ───────────────────────────────────────

  it('suppresses — rather than skips silently — an unresolvable use: entry', () => {
    const p = project(
      [
        route(`  method: 'GET', path: '/me', use: [cors()], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])

    const suppressions = suppressionsOf(p)
    expect(suppressions).toHaveLength(1)
    expect(suppressions[0]?.rule).toBe('kata/scoped-slot-not-provided')
    expect(suppressions[0]?.reason).toContain('cors()')
    expect(suppressions[0]?.file).toBe(ROUTE)
    expect(suppressions[0]?.affectedCount).toBe(1)
  })

  it('suppresses a use: chain containing a spread', () => {
    const p = project(
      [
        route(`  method: 'GET', path: '/me', use: [...shared], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toHaveLength(1)
  })

  it('suppresses a destructured handler context', () => {
    const p = project(
      [
        route(`  method: 'GET', path: '/me', input: {}, output: U,
  handler: ({ get }) => get('currentUser'),`),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)[0]?.reason).toContain('destructured')
  })

  it('suppresses an indeterminate scoped registry', () => {
    const p = project([READS_CURRENT_USER], null)
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)[0]?.reason).toContain('registry')
  })

  it('reports no registry gap for a directory that declares no route or app', () => {
    // A library, not an app: there is no chain to walk, so nothing was lost.
    const p = project([{ relPath: 'src/helpers.ts', text: 'export const x = 1' }], null)
    expect(suppressionsOf(p)).toEqual([])
  })

  it('proves nothing and reports nothing when the registry has no scoped slots', () => {
    const p = project([READS_CURRENT_USER], new Set())
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })

  it('still checks the reads an unresolvable entry cannot explain away', () => {
    // The killer case from #206: one unresolvable global entry used to disable
    // the rule everywhere. Now only reads it could actually cover are suppressed.
    const p = project(
      [
        AUTH_MW,
        appWith('[cors()]'),
        route(
          `  method: 'GET', path: '/me', use: [auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          IMPORT_AUTH,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([]) // nothing was left unproven
  })

  // ── ADR-0012: app-level (`createApp({ middlewares })`) providers ───────────

  it('does not flag a read provided by an app-level middleware, even with no use: chain', () => {
    const p = project(
      [
        AUTH_MW,
        appWith('[auth]', "import { auth } from './middlewares/auth'\n"),
        READS_CURRENT_USER,
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('still flags a read provided by neither the app-level chain nor use:', () => {
    const p = project(
      [
        AUTH_MW,
        appWith('[auth]', "import { auth } from './middlewares/auth'\n"),
        route(`  method: 'GET', path: '/me', input: {}, output: U,
  handler: (c) => c.get('tenantId'),`),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('reads app-level providers from a namespaced k.createApp call', () => {
    const main = {
      relPath: 'src/main.ts',
      text: `import { auth } from './middlewares/auth'
const app = k.createApp({ modules: [], middlewares: [auth] })`,
    }
    const p = project([AUTH_MW, main, READS_CURRENT_USER], SCOPED)
    expect(issuesOf(p)).toEqual([])
  })

  it('suppresses when the app-level middlewares chain contains a spread', () => {
    const p = project([appWith('[...shared]'), READS_CURRENT_USER], SCOPED)
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toHaveLength(1)
  })

  it('suppresses when the app-level middlewares value is not an array literal', () => {
    const p = project([appWith('sharedGlobals'), READS_CURRENT_USER], SCOPED)
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)[0]?.reason).toContain('not an array literal')
  })

  it('suppresses when the createApp config carries an object spread', () => {
    const main = { relPath: 'src/main.ts', text: `const app = createApp({ ...base, modules: [] })` }
    const p = project([main, READS_CURRENT_USER], SCOPED)
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toHaveLength(1)
  })

  it('suppresses when the createApp config is not an object literal', () => {
    const main = { relPath: 'src/main.ts', text: `const app = createApp(buildConfig())` }
    const p = project([main, READS_CURRENT_USER], SCOPED)
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toHaveLength(1)
  })

  it('a createApp without a middlewares chain leaves routes checked as before', () => {
    // Guard: the mere presence of createApp must not be treated as a global provider.
    const main = { relPath: 'src/main.ts', text: `const app = createApp({ modules: [] })` }
    const p = project([main, READS_CURRENT_USER], SCOPED)
    expect(issuesOf(p)).toHaveLength(1)
    expect(suppressionsOf(p)).toEqual([])
  })

  // ── kata/jwt guards as a handler: value (issue #211) ───────────────────────
  // `guard` / `requireRole` / `requireClaim` return a bare handler function, so
  // `handler: guard({ … })` is never a function literal the walker can step
  // into — before #211 this read was invisible to the rule entirely.

  /** Provides `tenantId` without reading anything else — keeps these fixtures to one slot. */
  const TENANT_MW = {
    relPath: 'src/middlewares/tenant.ts',
    text: `export const tenant = defineMiddleware({
      provides: ['tenantId'] as const,
      handler: (c, next) => { c.set('tenantId', 1); return next() },
    })`,
  }
  const IMPORT_TENANT = "import { tenant } from '../../middlewares/tenant'\n"

  it('flags a guard() middleware reading its slot before the provider runs', () => {
    const guardMw = {
      relPath: 'src/middlewares/require-tenant-owner.ts',
      text: `import { guard } from 'katajs/jwt'
export const requireTenantOwner = defineMiddleware({
  provides: [] as const,
  handler: guard({ slot: 'tenantId', authorize: (id) => id === 1 }),
})`,
    }
    const p = project(
      [
        TENANT_MW,
        guardMw,
        route(
          `  method: 'GET', path: '/me', use: [requireTenantOwner, tenant], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          `import { requireTenantOwner } from '../../middlewares/require-tenant-owner'\n${IMPORT_TENANT}`,
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('requireTenantOwner')
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('passes a guard() middleware whose slot is provided earlier in the chain', () => {
    const guardMw = {
      relPath: 'src/middlewares/require-tenant-owner.ts',
      text: `import { guard } from 'katajs/jwt'
export const requireTenantOwner = defineMiddleware({
  provides: [] as const,
  handler: guard({ slot: 'tenantId', authorize: (id) => id === 1 }),
})`,
    }
    const p = project(
      [
        TENANT_MW,
        guardMw,
        route(
          `  method: 'GET', path: '/me', use: [tenant, requireTenantOwner], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          `import { requireTenantOwner } from '../../middlewares/require-tenant-owner'\n${IMPORT_TENANT}`,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
  })

  it('defaults an unslotted guard() to reading `currentUser`', () => {
    const guardMw = {
      relPath: 'src/middlewares/require-admin.ts',
      text: `import { guard } from 'katajs/jwt'
export const requireAdmin = defineMiddleware({
  provides: [] as const,
  handler: guard({ authorize: (u) => u.role === 'admin' }),
})`,
    }
    const p = project(
      [
        AUTH_MW,
        guardMw,
        route(
          `  method: 'GET', path: '/me', use: [requireAdmin, auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          `import { requireAdmin } from '../../middlewares/require-admin'\n${IMPORT_AUTH}`,
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('requireAdmin')
    expect(issues[0]?.message).toContain("c.get('currentUser')")
  })

  it('flags requireRole() placed before its provider — the slot is its 2nd argument', () => {
    const requireRoleMw = {
      relPath: 'src/middlewares/admin-only.ts',
      text: `import { requireRole } from 'katajs/jwt'
export const adminOnly = defineMiddleware({
  provides: [] as const,
  handler: requireRole('admin'),
})`,
    }
    const p = project(
      [
        AUTH_MW,
        requireRoleMw,
        route(
          `  method: 'GET', path: '/me', use: [adminOnly, auth], input: {}, output: U,
  handler: (c) => c.get('currentUser'),`,
          `import { adminOnly } from '../../middlewares/admin-only'\n${IMPORT_AUTH}`,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toHaveLength(1)
  })

  it('flags requireClaim() reading its explicit slot — the 3rd argument', () => {
    const requireClaimMw = {
      relPath: 'src/middlewares/owner-only.ts',
      text: `import { requireClaim } from 'katajs/jwt'
export const ownerOnly = defineMiddleware({
  provides: [] as const,
  handler: requireClaim('id', 1, { slot: 'tenantId' }),
})`,
    }
    const p = project(
      [
        TENANT_MW,
        requireClaimMw,
        route(
          `  method: 'GET', path: '/me', use: [ownerOnly, tenant], input: {}, output: U,
  handler: (c) => c.get('tenantId'),`,
          `import { ownerOnly } from '../../middlewares/owner-only'\n${IMPORT_TENANT}`,
        ),
      ],
      SCOPED,
    )
    const issues = issuesOf(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('ownerOnly')
    expect(issues[0]?.message).toContain("c.get('tenantId')")
  })

  it('does not flag a guard() whose slot is a dynamic value (best-effort — a missed read, not a suppression)', () => {
    const guardMw = {
      relPath: 'src/middlewares/dynamic-guard.ts',
      text: `import { guard } from 'katajs/jwt'
const SLOT = 'tenantId'
export const dynamicGuard = defineMiddleware({
  provides: [] as const,
  handler: guard({ slot: SLOT, authorize: (id) => id === 1 }),
})`,
    }
    const p = project(
      [
        guardMw,
        route(
          `  method: 'GET', path: '/me', use: [dynamicGuard], input: {}, output: U,
  handler: (c) => 1,`,
          `import { dynamicGuard } from '../../middlewares/dynamic-guard'\n`,
        ),
      ],
      SCOPED,
    )
    expect(issuesOf(p)).toEqual([])
    expect(suppressionsOf(p)).toEqual([])
  })
})
