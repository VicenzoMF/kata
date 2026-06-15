import { defineRoute } from '../../context'

import { EchoBodySchema, EchoResponseSchema } from './echo.schema'

/**
 * A minimal POST route: `c.input.body` is typed from `EchoBodySchema` and the
 * return value is validated against `EchoResponseSchema`.
 *
 * The hardening middleware (CORS, secure response headers, and an 8 KiB
 * body-size limit — issue #67) is no longer wired here per route. It now runs
 * app-wide from `createApp({ middlewares })` in `main.ts` (ADR-0012, issue #87),
 * so every route — including this one — is hardened. `echo.hurl` still verifies
 * the headers ride along on the `/echo` response.
 */
export const echoRoute = defineRoute({
  method: 'POST',
  path: '/echo',
  input: { body: EchoBodySchema },
  output: EchoResponseSchema,
  handler: (c) => ({ echoed: c.input.body.message }),
})
