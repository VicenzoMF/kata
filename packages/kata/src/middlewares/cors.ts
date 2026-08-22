import { cors as honoCors } from 'hono/cors'

import type { Middleware } from '../context'
import type { Registry } from '../types'
import { fromHono } from './from-hono'

/**
 * Options for {@link cors}. Mirrors Hono's CORS options — `origin`,
 * `allowMethods`, `allowHeaders`, `exposeHeaders`, `maxAge`, `credentials`.
 * See https://hono.dev/docs/middleware/builtin/cors.
 */
export type CorsOptions = NonNullable<Parameters<typeof honoCors>[0]>

/**
 * Opt-in CORS middleware — a thin wrapper over Hono's `cors` shaped as a kata
 * {@link Middleware} so it drops into a route's `use` chain:
 *
 * ```ts
 * defineRoute({ method: 'POST', path: '/items', use: [cors()], ... })
 * ```
 *
 * It provides no scoped slots and only touches the underlying Hono context;
 * the `Access-Control-Allow-*` headers it sets survive into kata's final
 * response.
 *
 * Preflight: a `cors()` passed to `createApp`'s `middlewares` array (not a
 * per-route `use` chain) answers a browser preflight (`OPTIONS`) itself — kata
 * has no implicit `OPTIONS` route, so an unmatched `OPTIONS` request runs the
 * global chain before the 404/405 decision, and `cors()` there short-circuits
 * it with a `204` carrying the `Access-Control-Allow-*` headers. A per-route
 * `use: [cors()]`, like this one, still only decorates that route's actual
 * responses and does not answer `OPTIONS` for it. See
 * https://github.com/VicenzoMF/kata/blob/v0.3.1/docs/adr/0020-cors-preflight-and-response-transform-seam.md.
 */
export function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R> {
  return {
    __kata: 'middleware',
    provides: [],
    handler: fromHono<R>(honoCors(options)),
  }
}
