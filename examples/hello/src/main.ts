import { serve } from '@hono/node-server'
import { bodyLimit, cors, secureHeaders } from 'kata'

import { createApp, k } from './context'
import * as diag from './modules/diag/diag.route'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users, echo, diag],
  // App-level hardening (issue #87, ADR-0012): the global `middlewares` chain
  // runs before every route's own `use:`, so CORS, secure response headers, and
  // an 8 KiB body-size limit apply app-wide — declared once here instead of
  // copy-pasted onto each route. They `provides: []`, so no route has to list
  // them. (Full CORS preflight `OPTIONS` handling still wants `app.use('*',
  // cors())` on the returned Hono app — see the note in kata's cors.ts.)
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
  // Per-request logging through the registered `logger` singleton (issue #63):
  // every request logs method, path, status, duration, and its request id, and
  // the id is echoed on the `x-request-id` response header.
  requestLogging: true,
  // Output-schema mismatch handling (issue #17, ADR-0009): a hard 500 in
  // development for fast feedback, log-and-serve in production. This is the same
  // value `createApp` derives from NODE_ENV by default — set explicitly here to
  // show the knob.
  outputValidation: process.env['NODE_ENV'] === 'production' ? 'log' : 'strict',
})

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
