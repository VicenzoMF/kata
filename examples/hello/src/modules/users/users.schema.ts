import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

/**
 * Claims carried inside the JWT (ADR-0013). `sub` is the standard subject claim
 * — the user id — and `name`/`email` are extra claims this example stamps so a
 * verified token alone can populate `currentUser` without a database lookup.
 * `jwtAuth` validates the decoded payload against this schema; the `resolve()`
 * hook in `middlewares/auth.ts` then maps it onto the app's {@link User}.
 * Registered claims like `iat`/`exp` ride along on the token and are stripped by
 * this object schema.
 */
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

export const GetUserParamsSchema = z.object({
  id: z.string(),
})

export const BoomResponseSchema = z.object({
  ok: z.literal(true),
})

export type User = z.infer<typeof UserSchema>
export type UserClaims = z.infer<typeof UserClaimsSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
