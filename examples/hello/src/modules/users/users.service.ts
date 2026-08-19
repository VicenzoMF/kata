import type { CreateUserBody, User } from './users.schema'

const store = new Map<string, User>()

export async function getUser(id: string): Promise<User | null> {
  return store.get(id) ?? null
}

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  store.set(id, user)
  return user
}

export async function listUsers(): Promise<User[]> {
  return Array.from(store.values())
}

/** RFC 4180 field quoting: only when the field needs it (comma, quote, or newline). */
function csvField(value: string): string {
  return /["\r\n,]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function usersToCsv(users: User[]): string {
  const header = 'id,name,email'
  const rows = users.map((u) => [u.id, u.name, u.email].map(csvField).join(','))
  return [header, ...rows].join('\n')
}
