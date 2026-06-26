import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

import {
  BoomResponseSchema,
  CreateUserBodySchema,
  GetUserParamsSchema,
  UserSchema,
} from './users.schema'
import { createUser, getUser } from './users.service'

/**
 * Multi-status output (ADR-0011): the 200 success body is `UserSchema`; a miss
 * returns the unified error envelope (ADR-0008) at 404, declared with Kata's
 * `ErrorBodySchema`. Both bodies are now contract-validated at runtime, and
 * `hc<typeof app>` infers `InferResponseType<call, 200 | 404>` per status.
 */
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
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

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})

/**
 * Diagnostic route — deliberately throws to prove the global error boundary
 * (#62) funnels an uncaught handler error into the unified envelope (ADR-0008)
 * instead of leaking Hono's default text/HTML 500. Exercised by users.hurl,
 * the single E2E file the Kata harness runs in CI and the Stop hook.
 */
export const boomRoute = defineRoute({
  method: 'GET',
  path: '/boom',
  input: {},
  output: BoomResponseSchema,
  handler: () => {
    throw new Error('intentional handler explosion')
  },
})
