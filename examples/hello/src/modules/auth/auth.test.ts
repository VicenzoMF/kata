import { describe, expect, it } from 'vitest'

import { createApp } from '../../context'
import * as users from '../users/users.route'

import * as auth from './auth.route'

// A real kata app wired with just the auth + users routes, exercised in-process
// through `app.request()` (no live server). This mirrors the over-the-wire flow
// asserted in users.hurl, so the mint → verify → resolve → slot path is covered
// by `pnpm test` even where the Hurl suite is not run.
const app = createApp({ modules: [auth, users] })

async function mint(body: { id: string; name: string; email: string }): Promise<string> {
  const res = await app.request('/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as { token: string }
  return json.token
}

describe('auth: mint → GET /me round trip', () => {
  it('mints a token whose claims resolve to the User on /me (200)', async () => {
    const token = await mint({ id: '42', name: 'Ada', email: 'ada@example.com' })
    const res = await app.request('/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '42', name: 'Ada', email: 'ada@example.com' })
  })

  it('401s when the Authorization header is missing', async () => {
    const res = await app.request('/me', { method: 'GET' })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Missing bearer token' })
  })

  it('401s for a garbage bearer token', async () => {
    const res = await app.request('/me', {
      method: 'GET',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: 'Invalid or expired token',
    })
  })
})
