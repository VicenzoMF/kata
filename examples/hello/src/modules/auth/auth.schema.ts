import { z } from 'zod'

/**
 * Body for `POST /auth/token`: the identity to mint a token for. `id` becomes
 * the JWT `sub` (subject) claim; `name`/`email` are stamped as extra claims and
 * echoed back by `GET /me` once `resolve()` maps them onto the `User`.
 */
export const TokenRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

/** Response for `POST /auth/token`: the signed, compact JWT. */
export const TokenResponseSchema = z.object({
  token: z.string(),
})

export type TokenRequest = z.infer<typeof TokenRequestSchema>
export type TokenResponse = z.infer<typeof TokenResponseSchema>
