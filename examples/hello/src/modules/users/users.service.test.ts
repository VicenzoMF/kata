import { describe, expect, it } from 'vitest'

import { createUser, getUser } from './users.service'

describe('users.service', () => {
  it('createUser persists and returns the user with a uuid id', async () => {
    const user = await createUser({ name: 'Alice', email: 'a@example.com' })
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(user.name).toBe('Alice')
    expect(user.email).toBe('a@example.com')
  })

  it('getUser returns null for unknown ids', async () => {
    expect(await getUser('does-not-exist')).toBeNull()
  })

  it('getUser returns the previously created user by id', async () => {
    const created = await createUser({ name: 'Bob', email: 'b@example.com' })
    const fetched = await getUser(created.id)
    expect(fetched).toEqual(created)
  })
})
