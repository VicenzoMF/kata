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
 * must observe the final body. For those, use {@link fromHonoTransform}
 * instead (ADR-0020), which wires a real `next` and threads kata's final
 * `Response` back through the wrapped middleware. See
 * https://github.com/VicenzoMF/kata/blob/v0.3.1/docs/adr/0020-cors-preflight-and-response-transform-seam.md.
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

/**
 * Adapt a Hono middleware that must observe and replace kata's FINAL response
 * body — a response-transformer like `compress()` or `etag()` — into a kata
 * {@link Middleware} (ADR-0020, issue #159).
 *
 * Unlike {@link fromHono}, which runs the wrapped middleware BEFORE kata's
 * downstream chain with an inert `next` (correct for header-setters and
 * request-rejecters, wrong for transformers), `fromHonoTransform` wires a
 * REAL `next`: calling it runs kata's remaining chain and the route handler
 * to completion, places the resulting `Response` on `c.res` so the wrapped
 * middleware's post-`next` code can read and replace it — exactly how
 * `compress`/`etag` are written — then kata threads back whatever `c.res`
 * holds afterwards as its own response.
 *
 * A `fromHonoTransform` entry must be the FIRST entry of its route's
 * effective chain: it has to wrap everything downstream, or it cannot see
 * the final body. `registerRoute` enforces this at registration time and
 * throws a clear error otherwise, rather than silently doing nothing (the
 * failure mode `fromHono(compress())` has today).
 *
 * ```ts
 * import { compress } from 'hono/compress'
 * defineRoute({ method: 'GET', path: '/report', use: [fromHonoTransform(compress())], ... })
 * ```
 *
 * `fromHono` remains the default for header-setters and request-rejecters;
 * this is a distinct, opt-in adapter for the narrower response-transform
 * case. See
 * https://github.com/VicenzoMF/kata/blob/v0.3.1/docs/adr/0020-cors-preflight-and-response-transform-seam.md.
 */
export function fromHonoTransform<R extends Registry>(mw: MiddlewareHandler): Middleware<R> {
  return {
    __kata: 'middleware',
    provides: [],
    // Never runs through the normal chain — `registerRoute` recognises
    // `transform` and wires `mw` through the response-transform seam
    // directly, splicing this entry out of the chain it walks. This handler
    // only fires for a misuse the position guard didn't catch (an untyped/
    // raw construction bypassing `registerRoute`'s check) — loud failure
    // beats the silently-dropped body `fromHono(compress())` gave before
    // ADR-0020, so it throws rather than falling back to header-setter
    // semantics.
    handler: async () => {
      throw new Error(
        'kata: fromHonoTransform() middleware ran through the normal chain instead of the response-transform seam — it must be the first entry of its effective chain',
      )
    },
    transform: mw,
  }
}
