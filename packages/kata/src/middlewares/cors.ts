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
 * Preflight caveat: kata registers a handler only for a route's declared method
 * and has no implicit `OPTIONS` route, so a browser preflight (`OPTIONS`) is not
 * intercepted by `cors()` in a `use` chain — it still sets the CORS headers on
 * the actual response. For full preflight handling apply CORS at the app level
 * on the Hono instance returned by `createApp` (`app.use('*', ...)`).
 */
export function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R> {
  return {
    __kata: 'middleware',
    provides: [],
    handler: fromHono<R>(honoCors(options)),
  }
}
