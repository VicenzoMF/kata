import { bodyLimit, cors, secureHeaders } from 'kata'

import { defineRoute } from '../../context'

import { EchoBodySchema, EchoResponseSchema } from './echo.schema'

/**
 * Demonstrates the opt-in hardening middleware (issue #67) composed in a route's
 * `use` chain: CORS, secure response headers, and a request body-size limit.
 *
 * These are purely opt-in — `createApp`'s defaults are unchanged, and the other
 * routes (e.g. the users module) are unaffected. The 8 KiB limit guards
 * `c.req.json()`, which has no size guard of its own.
 */
export const echoRoute = defineRoute({
  method: 'POST',
  path: '/echo',
  use: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
  input: { body: EchoBodySchema },
  output: EchoResponseSchema,
  handler: (c) => ({ echoed: c.input.body.message }),
})
