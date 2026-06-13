import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users, echo] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
