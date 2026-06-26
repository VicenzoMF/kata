import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'
import { requireAuth } from '../../middlewares/auth'
import { withTransaction } from '../../middlewares/transaction'

import { GetOrderParamsSchema, OrderListSchema, OrderSchema } from './orders.schema'
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
  // Multi-status output (ADR-0011): success is 201 (not 200), with the order
  // validated against `OrderSchema`; the business failures map to the unified
  // error envelope at 409 / 422. (The 401 from `requireAuth` is a middleware
  // short-circuit — it never reaches the handler, so it is not declared here.)
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx')
    const result = checkout(tx, c.get('currentUser').id)
    if (!result.ok) {
      const envelope = describeCheckoutFailure(result)
      return c.error(envelope.code, envelope.message, { status: envelope.status })
    }
    const committed = tx.commit()
    if (!committed.ok) {
      // A concurrent checkout changed this product between our read and commit;
      // the tx rolled itself back (no oversell). Ask the client to retry.
      return c.error(
        'stock_conflict',
        `Stock for "${committed.conflict}" changed during checkout — please retry`,
        { status: 409 },
      )
    }
    // 201 Created. With the status→schema map above (ADR-0011), this body is now
    // validated against `output[201]` (OrderSchema) before it leaves the pipeline
    // — a non-200 success is no longer an unvalidated escape hatch.
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
  input: { params: GetOrderParamsSchema },
  output: OrderSchema,
  handler: (c) => {
    const order = getOrder(c.get('store'), c.get('currentUser').id, c.input.params.id)
    if (!order) return c.error('not_found', 'Order not found', { status: 404 })
    return order
  },
})
