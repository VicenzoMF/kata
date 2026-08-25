import { describe, expect, it } from 'vitest'

import { createStore } from '../../store'
import { addItem } from '../cart/cart.service'
import type { Product } from '../products/products.schema'

import { OrderSchema } from './orders.schema'
import { checkout, describeCheckoutFailure, getOrder, listOrders } from './orders.service'

const CATALOG: Product[] = [
  { id: 'mouse', name: 'Mouse', priceCents: 4500, stock: 10 },
  { id: 'kbd', name: 'Keyboard', priceCents: 12000, stock: 2 },
]

describe('orders.service checkout', () => {
  it('decrements stock, creates a schema-valid order, and clears the cart on commit', () => {
    const store = createStore(CATALOG)
    addItem(store, 'u1', { productId: 'mouse', qty: 2 })
    addItem(store, 'u1', { productId: 'kbd', qty: 1 })

    const tx = store.begin()
    const result = checkout(tx, 'u1')
    if (!result.ok) throw new Error('expected ok')
    tx.commit()

    expect(() => OrderSchema.parse(result.order)).not.toThrow()
    expect(result.order.totalCents).toBe(2 * 4500 + 1 * 12000)
    expect(result.order.status).toBe('paid')

    expect(store.getProduct('mouse')?.stock).toBe(8)
    expect(store.getProduct('kbd')?.stock).toBe(1)
    expect(store.getCart('u1')).toEqual([])
    expect(listOrders(store, 'u1').map((o) => o.id)).toEqual([result.order.id])
  })

  it('rejects an empty cart', () => {
    expect(checkout(createStore(CATALOG).begin(), 'u1')).toEqual({ ok: false, error: 'cart_empty' })
  })

  it('is atomic: one out-of-stock line rolls back the entire order', () => {
    const store = createStore(CATALOG)
    addItem(store, 'u1', { productId: 'mouse', qty: 1 }) // available
    addItem(store, 'u1', { productId: 'kbd', qty: 5 }) // only 2 in stock

    const tx = store.begin()
    const result = checkout(tx, 'u1')
    expect(result).toMatchObject({ ok: false, error: 'insufficient_stock', productId: 'kbd' })
    if (tx.status === 'open') tx.rollback() // what the withTransaction middleware does

    // the earlier mouse decrement was staged on tx, never committed → nothing moved
    expect(store.getProduct('mouse')?.stock).toBe(10)
    expect(store.getProduct('kbd')?.stock).toBe(2)
    expect(listOrders(store, 'u1')).toEqual([])
    expect(store.getCart('u1')).toHaveLength(2) // cart preserved so the user can retry
  })

  it('reports a cart line whose product no longer exists', () => {
    const store = createStore([])
    store.setCart('u1', [{ productId: 'ghost', name: 'Ghost', unitPriceCents: 100, qty: 1 }])
    expect(checkout(store.begin(), 'u1')).toMatchObject({
      ok: false,
      error: 'product_unavailable',
      productId: 'ghost',
    })
  })

  it('getOrder enforces ownership', () => {
    const store = createStore(CATALOG)
    addItem(store, 'owner', { productId: 'mouse', qty: 1 })
    const tx = store.begin()
    const result = checkout(tx, 'owner')
    if (!result.ok) throw new Error('expected ok')
    tx.commit()

    expect(getOrder(store, 'owner', result.order.id)?.id).toBe(result.order.id)
    expect(getOrder(store, 'intruder', result.order.id)).toBeUndefined()
  })

  it('listOrders is tenant-isolated: a user sees only their own orders', () => {
    const store = createStore(CATALOG)

    addItem(store, 'a', { productId: 'mouse', qty: 1 })
    const txA = store.begin()
    const resultA = checkout(txA, 'a')
    if (!resultA.ok) throw new Error('expected ok')
    txA.commit()

    addItem(store, 'b', { productId: 'kbd', qty: 1 })
    const txB = store.begin()
    const resultB = checkout(txB, 'b')
    if (!resultB.ok) throw new Error('expected ok')
    txB.commit()

    const aIds = listOrders(store, 'a').map((o) => o.id)
    expect(aIds).toEqual([resultA.order.id])
    expect(aIds).not.toContain(resultB.order.id)
    expect(listOrders(store, 'b').map((o) => o.id)).toEqual([resultB.order.id])
  })
})

describe('describeCheckoutFailure', () => {
  it('maps cart_empty to 422', () => {
    expect(describeCheckoutFailure({ ok: false, error: 'cart_empty' })).toEqual({
      code: 'cart_empty',
      message: 'Your cart is empty',
      status: 422,
    })
  })

  it('maps insufficient_stock to 409 with detail', () => {
    const envelope = describeCheckoutFailure({
      ok: false,
      error: 'insufficient_stock',
      productId: 'kbd',
      available: 2,
      requested: 5,
    })
    expect(envelope.status).toBe(409)
    expect(envelope.code).toBe('insufficient_stock')
    expect(envelope.message).toContain('kbd')
  })

  it('maps product_unavailable to 409', () => {
    expect(
      describeCheckoutFailure({ ok: false, error: 'product_unavailable', productId: 'x' }),
    ).toEqual({
      code: 'product_unavailable',
      message: 'Product x is no longer available',
      status: 409,
    })
  })
})
