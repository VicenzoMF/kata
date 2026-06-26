import { signJwt } from 'katajs/jwt'

import { JWT_SECRET, TOKEN_TTL_SECONDS } from '../../config'
import { defineRoute } from '../../context'

import { TokenRequestSchema, TokenResponseSchema } from './auth.schema'

/**
 * Mints a signed JWT for the given identity — a stand-in for a real
 * login/exchange endpoint so the example (and the Hurl suite) can obtain a token
 * without any external tooling. `name`/`email` are signed as extra claims and
 * the standard `sub` claim is set from `id` via `signJwt`'s `subject` option;
 * `requireUser` later verifies the result against `UserClaimsSchema`.
 *
 * This endpoint trusts its caller, so it is NOT how you authenticate real users:
 * a production `/auth/token` would verify credentials (or an OAuth code) before
 * signing. The shared `JWT_SECRET` (config.ts) is what ties this route to the
 * verifying middleware.
 */
export const mintTokenRoute = defineRoute({
  method: 'POST',
  path: '/auth/token',
  input: { body: TokenRequestSchema },
  output: TokenResponseSchema,
  handler: async (c) => {
    const { id, name, email } = c.input.body
    const token = await signJwt(
      { name, email },
      { secret: JWT_SECRET, subject: id, expiresInSeconds: TOKEN_TTL_SECONDS },
    )
    return { token }
  },
})
