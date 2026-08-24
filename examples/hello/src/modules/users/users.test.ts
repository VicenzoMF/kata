import { describe, expect, it } from 'vitest'

import { createUser, getUser, usersToCsv } from './users.service'

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

describe('usersToCsv', () => {
  it('renders a header row plus one row per user', () => {
    const csv = usersToCsv([{ id: '1', name: 'Ada', email: 'ada@example.com' }])
    expect(csv).toBe('id,name,email\n1,Ada,ada@example.com')
  })

  it('renders only the header row for an empty list', () => {
    expect(usersToCsv([])).toBe('id,name,email')
  })

  it('quotes a field that contains a comma, doubling any embedded quotes', () => {
    const csv = usersToCsv([{ id: '1', name: 'Doe, "Jr"', email: 'a@example.com' }])
    expect(csv).toBe('id,name,email\n1,"Doe, ""Jr""",a@example.com')
  })

  it('quotes a field that contains a bare carriage return (RFC 4180)', () => {
    const csv = usersToCsv([{ id: '1', name: 'Ada\rEvil', email: 'a@example.com' }])
    expect(csv).toBe('id,name,email\n1,"Ada\rEvil",a@example.com')
  })
})
