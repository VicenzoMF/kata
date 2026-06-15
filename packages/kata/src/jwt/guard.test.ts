import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Middleware } from '../context'
import { defineContext, scoped } from '../context'
import { guard, requireClaim, requireRole } from './index'

// Guards read an already-provided slot, so each test seeds `currentUser` with a
// trivial upstream middleware (standing in for `jwtAuth`) and runs the guard
// after it — exactly the ADR-0013 wiring: auth first, then the guard
// (`provides: []`). Exercised through Hono's `app.request()`, no live server.
const User = z.object({
  sub: z.string(),
  role: z.enum(['user', 'admin']),
  tier: z.string(),
})
type User = z.infer<typeof User>

const k = defineContext({ currentUser: scoped<User>() })
type AppHandler = Middleware<typeof k.registry>['handler']

const ADMIN: User = { sub: 'u1', role: 'admin', tier: 'gold' }
const MEMBER: User = { sub: 'u2', role: 'user', tier: 'free' }

/**
 * Mount `guardHandler` behind a middleware that seeds `currentUser` with `user`,
 * then a route that 200s `{ ok: true }` once the guard calls `next()`. The guard
 * either short-circuits (403) or lets the handler run, so the status alone
 * distinguishes allow from deny.
 */
function mount(user: User, guardHandler: AppHandler, headers: Record<string, string> = {}) {
  const seed = k.defineMiddleware({
    provides: ['currentUser'] as const,
    handler: (c, next) => {
      c.set('currentUser', user)
      return next()
    },
  })
  const guarded = k.defineMiddleware({ provides: [] as const, handler: guardHandler })
  const route = k.defineRoute({
    method: 'GET',
    path: '/guarded',
    use: [seed, guarded],
    input: {},
    output: z.object({ ok: z.literal(true) }),
    handler: () => ({ ok: true as const }),
  })
  const app = k.createApp({ modules: [{ route }] })
  return app.request('/guarded', { method: 'GET', headers })
}

describe('guard() — allow / deny', () => {
  it('calls next() (200) when authorize returns true', async () => {
    const res = await mount(
      ADMIN,
      guard<typeof k.registry, User>({ authorize: (u) => u.role === 'admin' }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('rejects with the default 403 forbidden envelope when authorize returns false', async () => {
    const res = await mount(
      MEMBER,
      guard<typeof k.registry, User>({ authorize: (u) => u.role === 'admin' }),
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'Insufficient permissions' })
  })

  it('honours a custom code and message', async () => {
    const res = await mount(
      MEMBER,
      guard<typeof k.registry, User>({
        authorize: () => false,
        code: 'not_admin',
        message: 'Admins only',
      }),
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not_admin', message: 'Admins only' })
  })

  it('awaits an async authorize predicate', async () => {
    const res = await mount(
      ADMIN,
      guard<typeof k.registry, User>({ authorize: (u) => Promise.resolve(u.role === 'admin') }),
    )

    expect(res.status).toBe(200)
  })

  it('passes the middleware context to authorize', async () => {
    const handler = guard<typeof k.registry, User>({
      authorize: (_user, c) => c.header('x-allow') === 'yes',
    })

    expect((await mount(MEMBER, handler, { 'x-allow': 'yes' })).status).toBe(200)
    expect((await mount(MEMBER, handler, { 'x-allow': 'no' })).status).toBe(403)
  })

  it('reads the slot named by `slot`', async () => {
    const k2 = defineContext({ viewer: scoped<User>() })
    const seed = k2.defineMiddleware({
      provides: ['viewer'] as const,
      handler: (c, next) => {
        c.set('viewer', ADMIN)
        return next()
      },
    })
    const guarded = k2.defineMiddleware({
      provides: [] as const,
      handler: guard<typeof k2.registry, User>({
        slot: 'viewer',
        authorize: (u) => u.role === 'admin',
      }),
    })
    const route = k2.defineRoute({
      method: 'GET',
      path: '/v',
      use: [seed, guarded],
      input: {},
      output: z.object({ ok: z.literal(true) }),
      handler: () => ({ ok: true as const }),
    })
    const app = k2.createApp({ modules: [{ route }] })

    expect((await app.request('/v', { method: 'GET' })).status).toBe(200)
  })
})

describe('requireRole()', () => {
  it('200s when the user has the required role', async () => {
    expect((await mount(ADMIN, requireRole<typeof k.registry>('admin'))).status).toBe(200)
  })

  it('403s with the forbidden envelope when the user lacks the role', async () => {
    const res = await mount(MEMBER, requireRole<typeof k.registry>('admin'))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'Insufficient permissions' })
  })

  it('accepts any of several roles', async () => {
    const anyOf = requireRole<typeof k.registry>(['admin', 'user'])

    expect((await mount(ADMIN, anyOf)).status).toBe(200)
    expect((await mount(MEMBER, anyOf)).status).toBe(200)
  })

  it('403s when the role is outside the allowed set', async () => {
    expect((await mount(MEMBER, requireRole<typeof k.registry>(['admin', 'root']))).status).toBe(
      403,
    )
  })
})

describe('requireClaim()', () => {
  it('200s when the claim equals the expected value', async () => {
    expect((await mount(ADMIN, requireClaim<typeof k.registry>('role', 'admin'))).status).toBe(200)
  })

  it('403s when the claim does not equal the expected value', async () => {
    expect((await mount(MEMBER, requireClaim<typeof k.registry>('role', 'admin'))).status).toBe(403)
  })

  it('accepts a predicate over the claim value', async () => {
    const goldOnly = requireClaim<typeof k.registry>('tier', (v: unknown) => v === 'gold')

    expect((await mount(ADMIN, goldOnly)).status).toBe(200)
    expect((await mount(MEMBER, goldOnly)).status).toBe(403)
  })

  it('403s when the claim is absent from the slot value', async () => {
    expect((await mount(ADMIN, requireClaim<typeof k.registry>('missing', 'x'))).status).toBe(403)
  })
})
