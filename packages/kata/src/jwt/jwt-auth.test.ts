import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineContext, scoped } from '../context'
import { jwtAuth, signJwt } from './index'

const SECRET = 'super-secret-key-for-tests'

const UserClaims = z.object({
  sub: z.string(),
  name: z.string(),
  role: z.enum(['user', 'admin']),
})
type User = z.infer<typeof UserClaims>

// A real kata app guarded by `jwtAuth`, wrapped exactly as an app would per
// ADR-0013 §3b: the library returns the *handler*, the call site owns the
// `defineMiddleware({ provides: [...] })`. Exercised through Hono's
// `app.request()` — no live server — so it covers the full path: header read,
// verify, `c.set`, the slot read in the handler, and the ADR-0008 envelope.
const k = defineContext({ currentUser: scoped<User>() })
const { defineRoute, defineMiddleware, createApp } = k

const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({ secret: SECRET, claims: UserClaims }),
})

// GET /me echoes the slot `requireUser` filled, so a 200 body proves `c.set` ran.
const me = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserClaims,
  handler: (c) => c.get('currentUser'),
})

const app = createApp({ modules: [{ me }] })

function get(headers: Record<string, string> = {}) {
  return app.request('/me', { method: 'GET', headers })
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** Flip the first char of the signature segment: still 3 parts, signature broken. */
function tamperSignature(token: string): string {
  const parts = token.split('.')
  const sig = parts[2] ?? ''
  parts[2] = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
  return parts.join('.')
}

describe('jwtAuth() — happy path', () => {
  it('verifies a bearer token, fills the slot, and the handler reads it back', async () => {
    const token = await signJwt({ sub: 'u1', name: 'Ada', role: 'admin' }, { secret: SECRET })
    const res = await get(bearer(token))

    expect(res.status).toBe(200)
    // `iat` (stamped by signJwt) is stripped by the UserClaims object schema.
    expect(await res.json()).toEqual({ sub: 'u1', name: 'Ada', role: 'admin' })
  })
})

describe('jwtAuth() — 401 failure paths (ADR-0008 envelope)', () => {
  it('401s with "Missing bearer token" when the header is absent', async () => {
    const res = await get()

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Missing bearer token' })
  })

  it('401s with "Missing bearer token" for a header lacking the Bearer scheme', async () => {
    const token = await signJwt({ sub: 'u1', name: 'Ada', role: 'user' }, { secret: SECRET })
    const res = await get({ authorization: token }) // raw token, no "Bearer " prefix

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Missing bearer token' })
  })

  it('401s with the generic "Invalid or expired token" for a tampered signature', async () => {
    const token = await signJwt({ sub: 'u1', name: 'Ada', role: 'user' }, { secret: SECRET })
    const res = await get(bearer(tamperSignature(token)))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: 'Invalid or expired token',
    })
  })

  it('collapses an expired token into the same generic "Invalid or expired token"', async () => {
    // A negative TTL makes `exp` already in the past at verify time.
    const token = await signJwt(
      { sub: 'u1', name: 'Ada', role: 'user' },
      { secret: SECRET, expiresInSeconds: -60 },
    )
    const res = await get(bearer(token))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: 'Invalid or expired token',
    })
  })

  it('401s "Token claims did not match" with structured issues under `claims`', async () => {
    // `role: 'superuser'` is outside the enum → signature valid, schema fails.
    const token = await signJwt({ sub: 'u1', name: 'Ada', role: 'superuser' }, { secret: SECRET })
    const res = await get(bearer(token))

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: 'unauthorized',
      message: 'Token claims did not match',
      issues: { claims: [{ path: 'role' }] },
    })
  })
})

describe('jwtAuth() — options', () => {
  it('honours a custom `slot` and `header`', async () => {
    const k2 = defineContext({ viewer: scoped<User>() })
    const requireViewer = k2.defineMiddleware({
      provides: ['viewer'] as const,
      handler: jwtAuth({
        secret: SECRET,
        claims: UserClaims,
        slot: 'viewer',
        header: 'x-access-token',
      }),
    })
    const who = k2.defineRoute({
      method: 'GET',
      path: '/who',
      use: [requireViewer],
      input: {},
      output: UserClaims,
      handler: (c) => c.get('viewer'),
    })
    const app2 = k2.createApp({ modules: [{ who }] })
    const token = await signJwt({ sub: 'u9', name: 'Grace', role: 'user' }, { secret: SECRET })

    // The default `authorization` header is now ignored — the token must arrive
    // on the configured header.
    const onWrongHeader = await app2.request('/who', { method: 'GET', headers: bearer(token) })
    expect(onWrongHeader.status).toBe(401)

    const onCustomHeader = await app2.request('/who', {
      method: 'GET',
      headers: { 'x-access-token': `Bearer ${token}` },
    })
    expect(onCustomHeader.status).toBe(200)
    expect(await onCustomHeader.json()).toEqual({ sub: 'u9', name: 'Grace', role: 'user' })
  })

  it('forwards issuer/audience to verifyJwt — a wrong issuer collapses to 401', async () => {
    const k3 = defineContext({ currentUser: scoped<User>() })
    const requireIssued = k3.defineMiddleware({
      provides: ['currentUser'] as const,
      handler: jwtAuth({
        secret: SECRET,
        claims: UserClaims,
        issuer: 'kata',
        audience: 'kata-app',
      }),
    })
    const route = k3.defineRoute({
      method: 'GET',
      path: '/me',
      use: [requireIssued],
      input: {},
      output: UserClaims,
      handler: (c) => c.get('currentUser'),
    })
    const app3 = k3.createApp({ modules: [{ me: route }] })

    const wrongIssuer = await signJwt(
      { sub: 'u1', name: 'Ada', role: 'user' },
      { secret: SECRET, issuer: 'evil', audience: 'kata-app' },
    )
    const rejected = await app3.request('/me', { method: 'GET', headers: bearer(wrongIssuer) })
    expect(rejected.status).toBe(401)
    expect(await rejected.json()).toEqual({
      error: 'unauthorized',
      message: 'Invalid or expired token',
    })

    const matching = await signJwt(
      { sub: 'u1', name: 'Ada', role: 'user' },
      { secret: SECRET, issuer: 'kata', audience: 'kata-app' },
    )
    const accepted = await app3.request('/me', { method: 'GET', headers: bearer(matching) })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ sub: 'u1', name: 'Ada', role: 'user' })
  })
})
