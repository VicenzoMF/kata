import type { MiddlewareHandler } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineContext } from '../context'
import { fromHono, fromHonoTransform } from './from-hono'
import { secureHeaders } from './secure-headers'

const k = defineContext({})
const { defineRoute, createApp } = k
type UseChain = NonNullable<Parameters<typeof k.defineRoute>[0]['use']>

// A minimal kata app with one POST /echo route, parameterised by the `use`
// chain under test. Exercised through Hono's `app.request()` — no live server.
function buildApp(use: UseChain, onHandlerCalled?: () => void) {
  const echo = defineRoute({
    method: 'POST',
    path: '/echo',
    use,
    input: { body: z.object({ msg: z.string() }) },
    output: z.object({ msg: z.string() }),
    handler: (c) => {
      onHandlerCalled?.()
      return c.input.body
    },
  })
  return createApp({ modules: [{ echo }] })
}

function post(app: ReturnType<typeof buildApp>, body: unknown = { msg: 'hi' }) {
  return app.request('/echo', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

// A trivial body-transformer, in the shape of `compress()`/`etag()`: it runs
// its own post-`next` code only after kata's downstream chain has built the
// final response, reads it off `c.res`, and replaces it — exactly the case
// `fromHono`'s inert `next` cannot support and `fromHonoTransform` exists for.
function uppercaseTransform(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const text = await c.res.clone().text()
    c.res = new Response(text.toUpperCase(), c.res)
  }
}

describe('fromHono() — a wrapped middleware that neither calls next nor returns a Response (issue #159)', () => {
  it('stops the chain: the route handler never runs', async () => {
    const noop: MiddlewareHandler = async () => {
      // Neither calls `next()` nor returns a `Response` — the untested branch
      // at from-hono.ts's `if (!proceeded) return`.
    }
    let handlerCalled = false
    const app = buildApp([{ __kata: 'middleware', provides: [], handler: fromHono(noop) }], () => {
      handlerCalled = true
    })
    const res = await post(app)
    expect(handlerCalled).toBe(false)
    // The registered Hono handler itself returns `undefined` (kata never built
    // a response), so Hono falls through to `notFound` — and since /echo does
    // declare POST, that resolves to a 405, not a 404.
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({
      error: 'method_not_allowed',
      message: 'Method not allowed',
    })
  })
})

describe('fromHonoTransform() — response-transform seam (ADR-0020, issue #159)', () => {
  it("observes and rewrites kata's final response body", async () => {
    const app = buildApp([fromHonoTransform(uppercaseTransform())])
    const res = await post(app, { msg: 'hi' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"MSG":"HI"}')
  })

  it('composes with a header-setting middleware declared after it in the chain', async () => {
    const app = buildApp([fromHonoTransform(uppercaseTransform()), secureHeaders()])
    const res = await post(app, { msg: 'hi' })
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('{"MSG":"HI"}')
  })

  it('a short-circuit before calling next never runs the handler', async () => {
    const rejecting: MiddlewareHandler = async (c) => c.json({ blocked: true }, 403)
    let handlerCalled = false
    const app = buildApp([fromHonoTransform(rejecting)], () => {
      handlerCalled = true
    })
    const res = await post(app)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ blocked: true })
    expect(handlerCalled).toBe(false)
  })

  it('works as an app-level (ADR-0012) global middleware, at position 0 of the effective chain', async () => {
    const echo = defineRoute({
      method: 'POST',
      path: '/echo',
      input: { body: z.object({ msg: z.string() }) },
      output: z.object({ msg: z.string() }),
      handler: (c) => c.input.body,
    })
    const app = createApp({
      modules: [{ echo }],
      middlewares: [fromHonoTransform(uppercaseTransform())],
    })
    const res = await post(app)
    expect(await res.text()).toBe('{"MSG":"HI"}')
  })

  it("throws at registration when not the first entry of a route's own use: chain", () => {
    expect(() => buildApp([secureHeaders(), fromHonoTransform(uppercaseTransform())])).toThrow(
      /must be the first entry/,
    )
  })

  it('throws at registration when an app-level global pushes it out of position 0', () => {
    const echo = defineRoute({
      method: 'POST',
      path: '/echo',
      use: [fromHonoTransform(uppercaseTransform())],
      input: { body: z.object({ msg: z.string() }) },
      output: z.object({ msg: z.string() }),
      handler: (c) => c.input.body,
    })
    expect(() => createApp({ modules: [{ echo }], middlewares: [secureHeaders()] })).toThrow(
      /must be the first entry/,
    )
  })

  it('its own handler throws if ever invoked outside the transform seam', async () => {
    const stray = fromHonoTransform(uppercaseTransform())
    await expect(
      // kata-allow: hono-boundary
      stray.handler({} as never, async () => {}),
    ).rejects.toThrow(/response-transform seam/)
  })
})
