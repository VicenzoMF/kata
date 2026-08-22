import { ErrorBodySchema } from '@katajs-framework/core'

import { defineRoute } from '../../context'
import { requireAuth } from '../../middlewares/auth'

import { AddCartItemBodySchema, CartSchema, RemoveCartItemParamsSchema } from './cart.schema'
import { addItem, readCart, removeItem } from './cart.service'

export const getCartRoute = defineRoute({
  method: 'GET',
  path: '/cart',
  use: [requireAuth],
  input: {},
  output: CartSchema,
  handler: (c) => readCart(c.get('store'), c.get('currentUser').id),
})

/**
 * Multi-status output (ADR-0011): the 200 success body is `CartSchema`; a miss
 * returns the unified error envelope at 404 (ADR-0008). A bare `Response`
 * against a plain Zod output no longer bypasses validation (ADR-0024), so the
 * 404 status must be declared here for `c.error` to type-check.
 */
export const addCartItemRoute = defineRoute({
  method: 'POST',
  path: '/cart/items',
  use: [requireAuth],
  input: { body: AddCartItemBodySchema },
  output: { 200: CartSchema, 404: ErrorBodySchema },
  handler: (c) => {
    const result = addItem(c.get('store'), c.get('currentUser').id, c.input.body)
    if (!result.ok) return c.error('product_not_found', 'Product not found', { status: 404 })
    return result.cart
  },
})

export const removeCartItemRoute = defineRoute({
  method: 'DELETE',
  path: '/cart/items/:productId',
  use: [requireAuth],
  input: { params: RemoveCartItemParamsSchema },
  output: CartSchema,
  handler: (c) => removeItem(c.get('store'), c.get('currentUser').id, c.input.params.productId),
})
