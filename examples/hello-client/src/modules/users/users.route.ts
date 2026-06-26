import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'

import {
  CreateUserBodySchema,
  GetUserParamsSchema,
  ListUsersQuerySchema,
  UserListSchema,
  UserSchema,
} from './users.schema'
import { createUser, getUser, listUsers } from './users.service'

export const listUsersRoute = defineRoute({
  method: 'GET',
  path: '/users',
  input: { query: ListUsersQuerySchema },
  output: UserListSchema,
  handler: async (c) => listUsers(c.input.query.q),
})

/**
 * Multi-status output (ADR-0011): 200 → `UserSchema`, 404 → the unified error
 * envelope. The client narrows on `res.status` with full types — see `getUser`
 * in `client.ts` and the per-status `InferResponseType` proofs there.
 */
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = getUser(c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
