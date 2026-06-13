import { secureHeaders as honoSecureHeaders } from 'hono/secure-headers'

import type { Middleware } from '../context'
import type { Registry } from '../types'
import { fromHono } from './from-hono'

/**
 * Options for {@link secureHeaders}. Mirrors Hono's secure-headers options, e.g.
 * `xFrameOptions`, `strictTransportSecurity`, `contentSecurityPolicy`,
 * `referrerPolicy`. Pass `false` for an individual header to disable it.
 * See https://hono.dev/docs/middleware/builtin/secure-headers.
 */
export type SecureHeadersOptions = NonNullable<Parameters<typeof honoSecureHeaders>[0]>

/**
 * Opt-in secure-response-headers middleware — a thin wrapper over Hono's
 * `secureHeaders` shaped as a kata {@link Middleware} for a route's `use` chain:
 *
 * ```ts
 * defineRoute({ method: 'GET', path: '/items', use: [secureHeaders()], ... })
 * ```
 *
 * With no options it applies Hono's hardened baseline — `X-Content-Type-Options:
 * nosniff`, `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security`, and more
 * — and removes `X-Powered-By`. It provides no scoped slots; the headers it sets
 * survive into kata's final response.
 */
export function secureHeaders<R extends Registry = Registry>(
  options?: SecureHeadersOptions,
): Middleware<R> {
  return {
    __kata: 'middleware',
    provides: [],
    handler: fromHono<R>(honoSecureHeaders(options)),
  }
}
