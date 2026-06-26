import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'katajs/node'

import { createApp, k } from './context'
import * as cart from './modules/cart/cart.route'
import * as orders from './modules/orders/orders.route'
import * as products from './modules/products/products.route'

const app = createApp({ modules: [products, cart, orders] })

const port = Number(process.env['PORT'] ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  k.resolve('logger').info(`shop listening on http://localhost:${info.port}`)
})

// Graceful shutdown (ADR-0014). On SIGTERM (orchestrator stop) or SIGINT
// (Ctrl-C), `gracefulShutdown` stops accepting connections, lets in-flight
// requests drain, then runs `onClose` — where we close the store, exactly where
// a real app would `await pool.end()`. The helper owns the signal trap, the
// drain ordering, and a force-exit timer; teardown order stays the app's.
gracefulShutdown(server, {
  onClose: async () => {
    await k.resolve('store').close()
    k.resolve('logger').info('store closed; shutdown complete')
  },
})
