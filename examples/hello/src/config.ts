/**
 * App configuration for the hello example.
 *
 * `JWT_SECRET` is shared by the token-minting route (`signJwt` in
 * `modules/auth`) and the auth middleware (`jwtAuth` in `middlewares/auth.ts`) —
 * they MUST agree or every token fails verification. The `dev-secret` fallback
 * keeps `pnpm --filter=hello dev` and the Hurl suite zero-config; a real app
 * sets `JWT_SECRET` in the environment (and should refuse to boot in production
 * when it is unset) — never ship `dev-secret`.
 */
export const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret'

/** Lifetime of a freshly minted token, in seconds (one hour). */
export const TOKEN_TTL_SECONDS = 60 * 60
