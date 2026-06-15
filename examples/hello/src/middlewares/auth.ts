import { jwtAuth } from 'kata/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

/**
 * Authentication via real JWTs (ADR-0013) — the production replacement for the
 * old `x-user-id` toy. `jwtAuth` reads `Authorization: Bearer <token>`, verifies
 * the signature and time claims, parses the payload through {@link UserClaimsSchema},
 * and on any failure short-circuits with the unified ADR-0008 401 envelope — so
 * the route handler only ever runs for an authenticated request.
 *
 * The `resolve()` hook (#93) maps the validated claims to the app's `User` that
 * lands in the `currentUser` slot, which keeps the slot typed `User` rather than
 * the raw claims. Here the token already carries everything `User` needs, so
 * `resolve` is a pure reshape (`sub` → `id`); in a real app this is the seam
 * where you would load the full user from your database by `claims.sub`
 * (returning `null` for an unknown subject renders a 401).
 *
 * `jwtAuth` returns just the handler; the `defineMiddleware({ provides })`
 * wrapper stays here at the call site so the `provides: ['currentUser']` literal
 * is greppable and lint-checkable (ADR-0013 §3b / ADR-0004).
 */
export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
