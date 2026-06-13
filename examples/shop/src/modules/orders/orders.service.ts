import type { Store, Transaction } from '../../store'

import type { Order, OrderLine } from './orders.schema'

export type CheckoutResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'cart_empty' }
  | { ok: false; error: 'product_unavailable'; productId: string }
  | {
      ok: false
      error: 'insufficient_stock'
      productId: string
      available: number
      requested: number
    }

export type CheckoutFailure = Extract<CheckoutResult, { ok: false }>

export type CheckoutErrorEnvelope = {
  code: string
  message: string
  status: number
}

/**
 * Turn the current user's cart into a paid order, atomically:
 *   validate stock -> decrement stock -> create order -> clear cart.
 * Every write is staged on the per-request `tx` (scoped slot, ADR-0004). The
 * route commits on success; on any failure this returns early, leaving `tx`
 * un-committed so the withTransaction middleware rolls back — a partial order
 * never persists. Kept synchronous so begin/stage/commit is one atomic tick.
 */
export function checkout(tx: Transaction, userId: string): CheckoutResult {
  const cartLines = tx.getCart(userId)
  if (cartLines.length === 0) return { ok: false, error: 'cart_empty' }

  const orderLines: OrderLine[] = []
  for (const line of cartLines) {
    const product = tx.getProduct(line.productId)
    if (!product) return { ok: false, error: 'product_unavailable', productId: line.productId }
    if (product.stock < line.qty) {
      return {
        ok: false,
        error: 'insufficient_stock',
        productId: product.id,
        available: product.stock,
        requested: line.qty,
      }
    }
    tx.putProduct({ ...product, stock: product.stock - line.qty })
    orderLines.push({
      productId: product.id,
      name: product.name,
      unitPriceCents: line.unitPriceCents,
      qty: line.qty,
    })
  }

  const order: Order = {
    id: crypto.randomUUID(),
    userId,
    lines: orderLines,
    totalCents: orderLines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0),
    status: 'paid',
    createdAt: new Date().toISOString(),
  }
  tx.putOrder(order)
  tx.setCart(userId, [])
  return { ok: true, order }
}

/** Map a checkout failure onto the unified error envelope (ADR-0008). */
export function describeCheckoutFailure(failure: CheckoutFailure): CheckoutErrorEnvelope {
  switch (failure.error) {
    case 'cart_empty':
      return { code: 'cart_empty', message: 'Your cart is empty', status: 422 }
    case 'product_unavailable':
      return {
        code: 'product_unavailable',
        message: `Product ${failure.productId} is no longer available`,
        status: 409,
      }
    case 'insufficient_stock':
      return {
        code: 'insufficient_stock',
        message: `Insufficient stock for ${failure.productId}: ${failure.available} available, ${failure.requested} requested`,
        status: 409,
      }
    default: {
      const exhaustive: never = failure
      return exhaustive
    }
  }
}

export function listOrders(store: Store, userId: string): Order[] {
  return store.listOrders(userId)
}

export function getOrder(store: Store, userId: string, id: string): Order | undefined {
  const order = store.getOrder(id)
  if (!order || order.userId !== userId) return undefined
  return order
}
