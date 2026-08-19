import type { MiddlewareHandler } from 'hono'
import type { Middleware } from '../context'
import { markContextHeadersTouched } from '../context'
import type { Registry } from '../types'

/**
 * Adapt a Hono middleware into a kata middleware handler.
 *
 * kata builds its response at the END of a route's middleware chain
 * (`c.json(...)` inside the final `next()`) and returns it detached from
 * `c.res`. A Hono middleware that sets response headers AFTER its own `next()`
 * — e.g. `secureHeaders` — would otherwise be dropped: its headers reach
 * `c.res` only after kata has already snapshotted them into the response.
 *
 * So we run the Hono middleware to completion FIRST, with an inert `next`, so
 * every header it sets (before and after its own `next`) is on `c.res` before
 * kata builds the response — then we continue kata's chain. If the Hono
 * middleware short-circuits with a `Response` (e.g. `bodyLimit`'s 413, a CORS
 * preflight 204), we return that instead and the chain stops.
 *
 * This runs the wrapped middleware's post-`next` logic BEFORE the downstream
 * handler, so it is correct for middleware that only set response headers or
 * reject a request — not for response-transformers (compression, ETag) that
 * must observe the final body. For those, ADR-0020 introduces an opt-in
 * `fromHonoTransform()` that wires a real `next` and threads Kata's final
 * `Response` back through the wrapped middleware. See
 * https://github.com/VicenzoMF/kata/blob/v0.1.0/docs/adr/0020-cors-preflight-and-response-transform-seam.md.
 *
 * Headers the wrapped middleware set land on `c.res` here, not on the
 * `Response` the route pipeline eventually builds — those are merged onto it
 * by `finalizeResponse` (issue #207). We mark the context as "touched" right
 * after running the middleware, whichever way it exits, so that merge step
 * knows to look.
 */
export function fromHono<R extends Registry>(mw: MiddlewareHandler): Middleware<R>['handler'] {
  return async (c, next) => {
    let proceeded = false
    const inert = async (): Promise<void> => {
      proceeded = true
    }
    const short = await mw(c.raw, inert)
    markContextHeadersTouched(c.raw)
    if (short instanceof Response) return short
    if (!proceeded) return
    await next()
  }
}
