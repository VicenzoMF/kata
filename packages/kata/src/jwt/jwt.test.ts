import { decode } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { signJwt, verifyJwt } from './index'

const SECRET = 'super-secret-key-for-tests'

const Claims = z.object({
  sub: z.string(),
  role: z.enum(['user', 'admin']),
})

/** Flip the first character of the signature segment so the token stays
 *  structurally valid (3 parts) but its signature no longer matches. */
function tamperSignature(token: string): string {
  const parts = token.split('.')
  const sig = parts[2] ?? ''
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
  parts[2] = flipped
  return parts.join('.')
}

describe('signJwt() / verifyJwt() round-trip', () => {
  it('verifies a freshly signed token back to the original claims', async () => {
    const token = await signJwt({ sub: 'u1', role: 'admin' }, { secret: SECRET })
    const result = await verifyJwt(token, { secret: SECRET, claims: Claims })

    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`)
    expect(result.claims).toEqual({ sub: 'u1', role: 'admin' })
  })

  it('honours a non-default algorithm on both sign and verify', async () => {
    const token = await signJwt({ sub: 'u1', role: 'user' }, { secret: SECRET, alg: 'HS512' })

    const ok = await verifyJwt(token, { secret: SECRET, claims: Claims, alg: 'HS512' })
    expect(ok.ok).toBe(true)

    // The header alg no longer matches the expected alg → rejected.
    const mismatch = await verifyJwt(token, { secret: SECRET, claims: Claims, alg: 'HS256' })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('invalid_token')
  })

  it('enforces issuer and audience when supplied to verify', async () => {
    const token = await signJwt(
      { sub: 'u1', role: 'user' },
      { secret: SECRET, issuer: 'kata', audience: 'kata-app' },
    )

    const ok = await verifyJwt(token, {
      secret: SECRET,
      claims: Claims,
      issuer: 'kata',
      audience: 'kata-app',
    })
    expect(ok.ok).toBe(true)

    const wrongIssuer = await verifyJwt(token, { secret: SECRET, claims: Claims, issuer: 'evil' })
    expect(wrongIssuer.ok).toBe(false)
    if (!wrongIssuer.ok) expect(wrongIssuer.error.code).toBe('invalid_token')

    const wrongAudience = await verifyJwt(token, {
      secret: SECRET,
      claims: Claims,
      audience: 'other',
    })
    expect(wrongAudience.ok).toBe(false)
  })
})

describe('signJwt() registered claims', () => {
  it('stamps iat and applies exp / nbf / iss / aud / sub from options', async () => {
    const token = await signJwt(
      { sub: 'ignored-by-option', custom: 'x' },
      {
        secret: SECRET,
        expiresInSeconds: 3600,
        notBeforeSeconds: 0,
        issuer: 'kata',
        audience: 'kata-app',
        subject: 'u42',
      },
    )

    const { payload } = decode(token)
    expect(payload.custom).toBe('x')
    expect(payload.iss).toBe('kata')
    expect(payload.aud).toBe('kata-app')
    expect(payload.sub).toBe('u42') // the `subject` option overrides claims.sub
    expect(typeof payload.iat).toBe('number')
    expect(payload.exp).toBe(Number(payload.iat) + 3600)
    expect(payload.nbf).toBe(Number(payload.iat))
  })
})

describe('verifyJwt() failure modes', () => {
  it('returns "expired" for a token past its exp', async () => {
    // A negative TTL makes `exp` already in the past at verify time.
    const token = await signJwt(
      { sub: 'u1', role: 'user' },
      { secret: SECRET, expiresInSeconds: -60 },
    )
    const result = await verifyJwt(token, { secret: SECRET, claims: Claims })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('expired')
  })

  it('returns "invalid_token" for a tampered token', async () => {
    const token = await signJwt({ sub: 'u1', role: 'user' }, { secret: SECRET })
    const result = await verifyJwt(tamperSignature(token), { secret: SECRET, claims: Claims })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_token')
  })

  it('returns "invalid_token" when verified with the wrong secret', async () => {
    const token = await signJwt({ sub: 'u1', role: 'user' }, { secret: SECRET })
    const result = await verifyJwt(token, {
      secret: 'a-completely-different-secret',
      claims: Claims,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_token')
  })

  it('returns "invalid_token" for a structurally malformed token', async () => {
    const result = await verifyJwt('not-a-jwt', { secret: SECRET, claims: Claims })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_token')
  })

  it('rejects a token used before its nbf as invalid_token', async () => {
    const token = await signJwt(
      { sub: 'u1', role: 'user' },
      { secret: SECRET, notBeforeSeconds: 3600 },
    )
    const result = await verifyJwt(token, { secret: SECRET, claims: Claims })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_token')
  })

  it('returns "claims_mismatch" with structured issues when the payload fails the schema', async () => {
    // `role` is outside the enum, so the signature is valid but the schema fails.
    const token = await signJwt({ sub: 'u1', role: 'superuser' }, { secret: SECRET })
    const result = await verifyJwt(token, { secret: SECRET, claims: Claims })

    if (result.ok) throw new Error('expected claims_mismatch')
    expect(result.error.code).toBe('claims_mismatch')
    expect(result.error.issues).toBeDefined()
    expect(result.error.issues?.[0]?.path).toBe('role')
  })
})
