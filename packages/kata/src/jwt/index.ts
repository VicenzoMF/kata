// `kata/jwt` — stateless JWT primitives (ADR-0013). This module is the *only*
// place that imports `hono/jwt`: `signJwt` / `verifyJwt` are a deliberately
// swappable seam, so a future move to `jose` (for JWE / advanced JWK, or a
// `hono/jwt` regression) needs no change to the public signatures below. Both
// are plain functions (ADR-0002, no classes); `verifyJwt` returns a Result
// rather than throwing, because an invalid/expired token is a normal, expected
// outcome — not an exception (ADR-0013 Alt. D).
//
// The Kata integration handlers `jwtAuth` / `guard` (ADR-0013 §3b) are
// intentionally NOT here yet: they land in #92 / #93 and depend on the Kata
// middleware/context types.
import { sign, verify } from 'hono/jwt'
import type { z } from 'zod'
import type { FieldIssue } from '../errors'
import { formatZodIssues } from '../errors'

/** Algorithms supported by the underlying `hono/jwt` (HS / RS / PS / ES + EdDSA). */
export type JwtAlgorithm =
  | 'HS256'
  | 'HS384'
  | 'HS512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA'

const DEFAULT_ALG: JwtAlgorithm = 'HS256'

/**
 * `hono/jwt`'s payload shape, re-derived from `verify` so this module imports
 * nothing from `hono/jwt` beyond `sign` / `verify` — keeping the swappable seam
 * a single import surface.
 */
type JwtPayload = Awaited<ReturnType<typeof verify>>

export type SignOptions = {
  secret: string
  /** Signing algorithm. Default `'HS256'`. */
  alg?: JwtAlgorithm
  /** Sets `exp = iat + expiresInSeconds`. */
  expiresInSeconds?: number
  /** Sets `nbf = iat + notBeforeSeconds`. */
  notBeforeSeconds?: number
  /** `iss` claim. */
  issuer?: string
  /** `aud` claim. */
  audience?: string
  /** `sub` claim. */
  subject?: string
}

/**
 * Sign a claims object into a compact JWT. Thin functional wrapper over
 * `hono/jwt`'s `sign`. Always stamps `iat` (issued-at = now); the registered
 * claims derived from `options` (`exp`, `nbf`, `iss`, `aud`, `sub`) override any
 * same-named key in `claims`. Rejects only on a misconfigured key/algorithm — a
 * programmer error with no caller-handled branch (contrast `verifyJwt`, which
 * returns a Result).
 */
export function signJwt(claims: Record<string, unknown>, options: SignOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = {}
  Object.assign(payload, claims)
  payload.iat = now
  if (options.expiresInSeconds !== undefined) payload.exp = now + options.expiresInSeconds
  if (options.notBeforeSeconds !== undefined) payload.nbf = now + options.notBeforeSeconds
  if (options.issuer !== undefined) payload.iss = options.issuer
  if (options.audience !== undefined) payload.aud = options.audience
  if (options.subject !== undefined) payload.sub = options.subject
  return sign(payload, options.secret, options.alg ?? DEFAULT_ALG)
}

export type VerifyOptions<S extends z.ZodTypeAny> = {
  secret: string
  /** Schema the decoded payload must satisfy. Its `z.infer` is the success type. */
  claims: S
  /** Expected signing algorithm. Default `'HS256'`. */
  alg?: JwtAlgorithm
  /** When set, require this `iss` claim. */
  issuer?: string
  /** When set, require this `aud` claim. */
  audience?: string
}

export type JwtErrorCode = 'invalid_token' | 'expired' | 'claims_mismatch'

export type JwtError = {
  readonly code: JwtErrorCode
  readonly message: string
  /** Present only when `code === 'claims_mismatch'` — reuses the ADR-0008 shape. */
  readonly issues?: FieldIssue[]
}

export type JwtVerifyResult<T> =
  | { readonly ok: true; readonly claims: T }
  | { readonly ok: false; readonly error: JwtError }

/**
 * Verify signature + time claims (and `iss` / `aud` when supplied) via
 * `hono/jwt`, then parse the payload through `options.claims`. Returns a Result
 * rather than throwing: an invalid/expired token is an expected outcome. A Zod
 * failure becomes `claims_mismatch` with structured `issues` (via
 * `formatZodIssues`); signature / structure / `iss` / `aud` / algorithm failures
 * collapse to `invalid_token`; an expired token to `expired`.
 */
export async function verifyJwt<S extends z.ZodTypeAny>(
  token: string,
  options: VerifyOptions<S>,
): Promise<JwtVerifyResult<z.infer<S>>> {
  let payload: JwtPayload
  try {
    payload = await verify(
      token,
      options.secret,
      buildVerifyOptions(options.alg ?? DEFAULT_ALG, options.issuer, options.audience),
    )
  } catch (error) {
    return { ok: false, error: toJwtError(error) }
  }

  const parsed = options.claims.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'claims_mismatch',
        message: 'Token claims did not match the expected schema',
        issues: formatZodIssues(parsed.error),
      },
    }
  }

  return { ok: true, claims: parsed.data }
}

/** Build the `hono/jwt` verify options, attaching `iss` / `aud` only when set. */
function buildVerifyOptions(
  alg: JwtAlgorithm,
  issuer: string | undefined,
  audience: string | undefined,
): { alg: JwtAlgorithm; iss?: string; aud?: string } {
  const verifyOptions: { alg: JwtAlgorithm; iss?: string; aud?: string } = { alg }
  if (issuer !== undefined) verifyOptions.iss = issuer
  if (audience !== undefined) verifyOptions.aud = audience
  return verifyOptions
}

/**
 * Map a `hono/jwt` verify throw onto a {@link JwtError}. Only `JwtTokenExpired`
 * becomes `expired`; every other failure (malformed token, signature mismatch,
 * algorithm / issuer / audience mismatch, not-before) collapses to
 * `invalid_token`, so the verifier never doubles as a validity oracle. Keyed on
 * the error `name` (every `hono/jwt` error sets it) so this module imports
 * nothing from `hono/jwt` beyond `sign` / `verify`.
 */
function toJwtError(error: unknown): JwtError {
  const name = error instanceof Error ? error.name : ''
  if (name === 'JwtTokenExpired') {
    return { code: 'expired', message: 'Token has expired' }
  }
  return { code: 'invalid_token', message: 'Token is invalid' }
}
