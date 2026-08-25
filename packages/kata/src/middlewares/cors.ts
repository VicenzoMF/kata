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
 * Preflight: kata has no implicit `OPTIONS` route, so a browser preflight
 * (`OPTIONS /items` with `Access-Control-Request-Method`) would otherwise 404
 * before `cors()` ever ran. `buildHonoApp` closes that gap (ADR-0020,
 * issue #158): every path whose effective chain (per-route `use:` or an
 * ADR-0012 global) carries a `cors()` gets a synthetic `OPTIONS <path>`
 * responder auto-registered, running just the CORS headers for that path —
 * no code to write beyond declaring `cors()` itself. See
 * https://github.com/VicenzoMF/kata/blob/v0.3.1/docs/adr/0020-cors-preflight-and-response-transform-seam.md.
 */
export function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R> {
  return {
    __kata: 'middleware',
    provides: [],
    handler: fromHono<R>(honoCors(options)),
    preflight: options ?? {},
  }
}
