import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as diag from './modules/diag/diag.route'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users, echo, diag],
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
