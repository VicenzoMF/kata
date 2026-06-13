import { describe, expect, it } from 'vitest'

import type { Product } from './modules/products/products.schema'
import { createStore } from './store'

const product = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
  name: 'Thing',
  priceCents: 100,
  stock: 5,
  ...over,
})

describe('store transactions', () => {
  it('staged writes are invisible to the store until commit', () => {
    const store = createStore([product()])
    const tx = store.begin()
    tx.putProduct(product({ stock: 0 }))

    expect(store.getProduct('p1')?.stock).toBe(5) // committed value
    expect(tx.getProduct('p1')?.stock).toBe(0) // tx sees its own staged write

    tx.commit()
    expect(store.getProduct('p1')?.stock).toBe(0)
    expect(tx.status).toBe('committed')
  })

  it('rollback discards staged writes', () => {
    const store = createStore([product()])
    const tx = store.begin()
    tx.putProduct(product({ stock: 0 }))
    tx.setCart('u1', [{ productId: 'p1', name: 'Thing', unitPriceCents: 100, qty: 1 }])
    tx.rollback()

    expect(store.getProduct('p1')?.stock).toBe(5)
    expect(store.getCart('u1')).toEqual([])
    expect(tx.status).toBe('rolled-back')
  })

  it('a never-committed transaction leaves the store untouched', () => {
    const store = createStore([product()])
    store.begin().putProduct(product({ stock: 1 }))
    expect(store.getProduct('p1')?.stock).toBe(5)
  })

  it('commit refuses to persist negative stock (all-or-nothing invariant)', () => {
    const store = createStore([product()])
    const tx = store.begin()
    tx.putProduct(product({ stock: -1 }))
    expect(() => tx.commit()).toThrow(/negative stock/)
    expect(store.getProduct('p1')?.stock).toBe(5)
  })

  it('a settled transaction cannot be reused', () => {
    const store = createStore([product()])
    const tx = store.begin()
    tx.commit()
    expect(() => tx.commit()).toThrow(/already committed/)
    expect(() => tx.putProduct(product())).toThrow(/already committed/)
  })

  it('concurrent transactions are isolated until commit', () => {
    const store = createStore([product()])
    const a = store.begin()
    const b = store.begin()
    a.putProduct(product({ stock: 2 }))

    expect(b.getProduct('p1')?.stock).toBe(5) // b cannot see a's uncommitted write
    a.commit()
    expect(b.getProduct('p1')?.stock).toBe(2) // but reads the committed store underneath
  })
})
