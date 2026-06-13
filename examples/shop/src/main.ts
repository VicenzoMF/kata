import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as cart from './modules/cart/cart.route'
import * as orders from './modules/orders/orders.route'
import * as products from './modules/products/products.route'

const app = createApp({ modules: [products, cart, orders] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`shop listening on http://localhost:${info.port}`)
})
