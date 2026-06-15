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
import type { Middleware } from '../context'
import type { FieldIssue } from '../errors'
import { formatZodIssues } from '../errors'
import type { Registry } from '../types'

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

// ── Kata integration (middleware handler) — ADR-0013 §3b–§5 ───────────────────
// `jwtAuth` is the Kata-aware layer over `verifyJwt`: it reads a bearer token,
// verifies it, and writes the validated claims into a scoped slot. It returns
// just the *handler* (mirroring `fromHono` in `../middlewares/from-hono.ts`) so
// the caller owns the `defineMiddleware({ provides: [...] })` wrapper — keeping
// the `provides` literal at the call site where the ADR-0004 lint rules can read
// it (ADR-0013 Alternative C, rejected: hiding `provides` inside the package).

/** Scoped slot `jwtAuth` fills when `slot` is omitted. */
const DEFAULT_SLOT = 'currentUser'

/** Request header `jwtAuth` reads the bearer token from when `header` is omitted. */
const DEFAULT_HEADER = 'authorization'

/** `Authorization: Bearer <token>` — the auth scheme is case-insensitive (RFC 7235 §2.1). */
const BEARER_SCHEME = /^Bearer\s+(\S+)$/i

export type JwtAuthOptions<S extends z.ZodTypeAny> = {
  secret: string
  /** Schema the JWT payload must satisfy; its `z.infer` becomes the slot value. */
  claims: S
  /** Scoped slot to populate with the validated claims. Default `'currentUser'`. */
  slot?: string
  /** Expected signing algorithm. Default `'HS256'`. */
  alg?: JwtAlgorithm
  /** When set, require this `iss` claim. */
  issuer?: string
  /** When set, require this `aud` claim. */
  audience?: string
  /** Request header to read the bearer token from. Default `'authorization'`. */
  header?: string
}

/**
 * Build a Kata middleware *handler* that authenticates a request via JWT and
 * writes the validated claims into a scoped slot (ADR-0013 §3b–§5). It reads
 * `Authorization: Bearer <token>` (header configurable), runs {@link verifyJwt},
 * and on success `c.set(slot, claims)` with the Zod-validated payload — never a
 * raw `any`. Every authentication failure renders the unified ADR-0008 envelope
 * as a 401:
 *
 * - missing / malformed bearer header → `Missing bearer token`
 * - invalid signature / structure / expired → `Invalid or expired token`
 *   (`invalid_token` and `expired` collapse to one message — no validity oracle)
 * - payload fails `claims` → `Token claims did not match`, with the Zod issues
 *   carried under the envelope's `issues.claims`
 *
 * Returns the handler only — the caller wraps it with
 * `defineMiddleware({ provides: [slot], ... })` so the `provides` literal stays
 * greppable / lint-checkable at the call site (ADR-0013 Alternative C). That the
 * slot string is a real `ScopedKeys<R>` whose declared type matches `z.infer<S>`
 * is guaranteed there by `provides` + lint, not by this signature (`R` is not
 * inferable from `options`; ADR-0013 §4).
 */
export function jwtAuth<R extends Registry, S extends z.ZodTypeAny>(
  options: JwtAuthOptions<S>,
): Middleware<R>['handler'] {
  const slot = options.slot ?? DEFAULT_SLOT
  const header = options.header ?? DEFAULT_HEADER
  return async (c, next) => {
    const token = readBearerToken(c.header(header))
    if (token === undefined) {
      return c.error('unauthorized', 'Missing bearer token', { status: 401 })
    }

    const result = await verifyJwt(token, {
      secret: options.secret,
      claims: options.claims,
      alg: options.alg,
      issuer: options.issuer,
      audience: options.audience,
    })
    if (!result.ok) {
      if (result.error.code === 'claims_mismatch') {
        return c.error('unauthorized', 'Token claims did not match', {
          status: 401,
          issues: { claims: result.error.issues ?? [] },
        })
      }
      return c.error('unauthorized', 'Invalid or expired token', { status: 401 })
    }

    // ADR-0013 §4: `slot` is a runtime string and `R` is opaque here, so widen
    // `set` to its string-keyed form. The slot's membership in `ScopedKeys<R>`
    // and that `z.infer<S>` matches its declared type are enforced at the call
    // site (`provides` + lint), exactly as ADR-0004 documents for scoped reads.
    const setSlot = c.set as unknown as (key: string, value: z.infer<S>) => void
    setSlot(slot, result.claims)
    await next()
  }
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header value. Returns
 * `undefined` when the header is absent or not a well-formed single-token bearer
 * credential — both of which `jwtAuth` renders as the same generic 401.
 */
function readBearerToken(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) return undefined
  const match = BEARER_SCHEME.exec(headerValue.trim())
  return match?.[1]
}
