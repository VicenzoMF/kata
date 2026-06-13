import { serve } from '@hono/node-server'

import { k } from './context'
import { app } from './server'

// A runnable server for the typed routes. Start it (`pnpm --filter hello-client
// start`) and point any `hc<AppType>(baseUrl)` client at it — the client needs
// only the exported `AppType`, never this runtime.
const port = Number(process.env['PORT'] ?? 3001)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`hello-client listening on http://localhost:${info.port}`)
})
