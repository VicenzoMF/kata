import { describe, expect, it } from 'vitest'

import { createStore } from '../../store'
import type { Product } from '../products/products.schema'

import { addItem, readCart, removeItem } from './cart.service'

const CATALOG: Product[] = [
  { id: 'mouse', name: 'Mouse', priceCents: 4500, stock: 10 },
  { id: 'kbd', name: 'Keyboard', priceCents: 12000, stock: 5 },
]

describe('cart.service', () => {
  it('readCart returns an empty cart for a new user', () => {
    expect(readCart(createStore(CATALOG), 'u1')).toEqual({ userId: 'u1', lines: [], totalCents: 0 })
  })

  it('addItem snapshots price/name and computes the total', () => {
    const result = addItem(createStore(CATALOG), 'u1', { productId: 'mouse', qty: 2 })
    if (!result.ok) throw new Error('expected ok')
    expect(result.cart.lines).toEqual([
      { productId: 'mouse', name: 'Mouse', unitPriceCents: 4500, qty: 2 },
    ])
    expect(result.cart.totalCents).toBe(9000)
  })

  it('addItem merges quantity for a product already in the cart', () => {
    const store = createStore(CATALOG)
    addItem(store, 'u1', { productId: 'mouse', qty: 2 })
    const result = addItem(store, 'u1', { productId: 'mouse', qty: 3 })
    if (!result.ok) throw new Error('expected ok')
    expect(result.cart.lines).toHaveLength(1)
    expect(result.cart.lines[0]?.qty).toBe(5)
    expect(result.cart.totalCents).toBe(22500)
  })

  it('addItem rejects unknown products', () => {
    expect(addItem(createStore(CATALOG), 'u1', { productId: 'ghost', qty: 1 })).toEqual({
      ok: false,
      error: 'product_not_found',
    })
  })

  it('removeItem drops the line and recomputes the total', () => {
    const store = createStore(CATALOG)
    addItem(store, 'u1', { productId: 'mouse', qty: 1 })
    addItem(store, 'u1', { productId: 'kbd', qty: 1 })
    const cart = removeItem(store, 'u1', 'mouse')
    expect(cart.lines.map((line) => line.productId)).toEqual(['kbd'])
    expect(cart.totalCents).toBe(12000)
  })
})
