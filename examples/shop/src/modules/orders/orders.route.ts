import { z } from 'zod'

import { defineRoute } from '../../context'
import { requireAuth } from '../../middlewares/auth'
import { withTransaction } from '../../middlewares/transaction'

import { OrderListSchema, OrderSchema } from './orders.schema'
import { checkout, describeCheckoutFailure, getOrder, listOrders } from './orders.service'

/**
 * Checkout — the multi-domain, transactional centerpiece. `requireAuth`
 * provides `currentUser`; `withTransaction` provides the `tx` scoped slot. The
 * service stages stock decrements + the new order + the cart clear on `tx`; we
 * commit on success, or return an error and let the middleware roll back.
 */
export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: OrderSchema,
  handler: (c) => {
    const tx = c.get('tx')
    const result = checkout(tx, c.get('currentUser').id)
    if (!result.ok) {
      const envelope = describeCheckoutFailure(result)
      return c.error(envelope.code, envelope.message, { status: envelope.status })
    }
    tx.commit()
    // 201 Created. Returning a Response short-circuits the pipeline (skipping
    // output validation) — the framework's only way to set a non-200 status.
    return c.json(result.order, 201)
  },
})

export const listOrdersRoute = defineRoute({
  method: 'GET',
  path: '/orders',
  use: [requireAuth],
  input: {},
  output: OrderListSchema,
  handler: (c) => listOrders(c.get('store'), c.get('currentUser').id),
})

export const getOrderRoute = defineRoute({
  method: 'GET',
  path: '/orders/:id',
  use: [requireAuth],
  input: { params: z.object({ id: z.string() }) },
  output: OrderSchema,
  handler: (c) => {
    const order = getOrder(c.get('store'), c.get('currentUser').id, c.input.params.id)
    if (!order) return c.error('not_found', 'Order not found', { status: 404 })
    return order
  },
})
