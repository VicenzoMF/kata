import type { CreateUserBody, User } from './users.schema'

/** In-memory store — an example stand-in for a real repository. */
const users = new Map<string, User>()

export function createUser(input: CreateUserBody): User {
  const user: User = { id: crypto.randomUUID(), name: input.name, email: input.email }
  users.set(user.id, user)
  return user
}

export function getUser(id: string): User | undefined {
  return users.get(id)
}

export function listUsers(query?: string): User[] {
  const all = [...users.values()]
  if (!query) return all
  const needle = query.toLowerCase()
  return all.filter((user) => user.name.toLowerCase().includes(needle))
}
