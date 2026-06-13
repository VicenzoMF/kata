import { testClient } from 'hono/testing'
import { describe, expect, it } from 'vitest'

import { app } from './server'

/**
 * Runtime proof that the typed client and the live routes agree. `testClient`
 * binds `hc<typeof app>` to the in-process app, so these calls drive the full
 * Kata pipeline (input validation → handler → output validation) with the exact
 * types client.ts asserts at compile time — the type fixture and the runtime
 * cannot silently drift apart.
 */
describe('hello-client RPC', () => {
  const client = testClient(app)

  it('creates a user and reads it back with typed bodies', async () => {
    const created = await client.users.$post({ json: { name: 'Ada', email: 'ada@example.com' } })
    expect(created.status).toBe(200)
    const user = await created.json()
    expect(user).toMatchObject({ name: 'Ada', email: 'ada@example.com' })
    expect(typeof user.id).toBe('string')

    const fetched = await client.users[':id'].$get({ param: { id: user.id } })
    expect(fetched.status).toBe(200)
    expect(await fetched.json()).toEqual(user)
  })

  it('lists users and filters by the typed query', async () => {
    await client.users.$post({ json: { name: 'Grace Hopper', email: 'grace@example.com' } })

    const all = await client.users.$get({ query: {} })
    expect(all.status).toBe(200)
    expect((await all.json()).length).toBeGreaterThan(0)

    const filtered = await client.users.$get({ query: { q: 'grace' } })
    const names = (await filtered.json()).map((u) => u.name)
    expect(names).toContain('Grace Hopper')
    expect(names).not.toContain('Ada')
  })

  it('rejects an invalid body at runtime with 422', async () => {
    const res = await client.users.$post({ json: { name: '', email: 'not-an-email' } })
    expect(res.status).toBe(422)
  })
})
