import type { Context } from 'hono'
import { bodyLimit as honoBodyLimit } from 'hono/body-limit'

import type { Middleware } from '../context'
import { buildErrorBody } from '../errors'
import type { Registry } from '../types'
import { fromHono } from './from-hono'

/** Default maximum request body size applied by {@link bodyLimit}: 1 MiB. */
export const DEFAULT_MAX_BODY_SIZE = 1024 * 1024

/** Options for {@link bodyLimit}. */
export type BodyLimitOptions = {
  /**
   * Maximum request body size in bytes. Defaults to
   * {@link DEFAULT_MAX_BODY_SIZE} (1 MiB).
   */
  maxSize?: number
  /**
   * Response returned when the limit is exceeded. Defaults to HTTP 413 with the
   * unified kata error envelope (ADR-0008): `{ error: 'payload_too_large', ... }`.
   */
  onError?: (c: Context) => Response | Promise<Response>
}

const defaultOnError = (c: Context): Response =>
  c.json(buildErrorBody('payload_too_large', 'Request body exceeds the maximum allowed size'), 413)

/**
 * Opt-in request body-size limit — a thin wrapper over Hono's `bodyLimit` shaped
 * as a kata {@link Middleware}. kata's runtime reads the body via `c.req.json()`
 * with no size guard, so add this to a route's `use` chain to reject oversized
 * payloads before they are buffered and parsed:
 *
 * ```ts
 * defineRoute({ method: 'POST', path: '/items', use: [bodyLimit({ maxSize: 64 * 1024 })], ... })
 * ```
 *
 * The limit is enforced via the `Content-Length` header (fast path) and, when no
 * `Content-Length` is present, by measuring the streamed body. It provides no
 * scoped slots.
 */
export function bodyLimit<R extends Registry = Registry>(
  options?: BodyLimitOptions,
): Middleware<R> {
  const handle = honoBodyLimit({
    maxSize: options?.maxSize ?? DEFAULT_MAX_BODY_SIZE,
    onError: options?.onError ?? defaultOnError,
  })
  return {
    __kata: 'middleware',
    provides: [],
    handler: fromHono<R>(handle),
  }
}
