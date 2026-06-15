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

    expect(tx.commit()).toEqual({ ok: true })
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

  it('reads are isolated until commit', () => {
    const store = createStore([product()])
    const a = store.begin()
    const b = store.begin()
    a.putProduct(product({ stock: 2 }))

    expect(b.getProduct('p1')?.stock).toBe(5) // b cannot see a's uncommitted write
    a.commit()
    expect(b.getProduct('p1')?.stock).toBe(2) // but reads the committed store underneath
  })

  it('refuses a stale write at commit — optimistic concurrency, no lost update', () => {
    const store = createStore([product({ stock: 1 })])
    const a = store.begin()
    const b = store.begin()

    expect(a.getProduct('p1')?.stock).toBe(1) // both read the same committed base
    expect(b.getProduct('p1')?.stock).toBe(1)
    a.putProduct(product({ stock: 0 })) // a sells the last unit: 1 -> 0
    b.putProduct(product({ stock: 0 })) // b decrements off the now-stale read of 1

    expect(a.commit()).toEqual({ ok: true })
    expect(b.commit()).toEqual({ ok: false, conflict: 'p1' }) // lost update refused
    expect(store.getProduct('p1')?.stock).toBe(0) // only one decrement applied — never oversold
    expect(b.status).toBe('rolled-back')
  })
})

describe('store lifecycle', () => {
  it('close() releases the data and is idempotent', async () => {
    const store = createStore([product()])

    await store.close()
    expect(store.listProducts()).toEqual([]) // backing data released

    await expect(store.close()).resolves.toBeUndefined() // safe to call more than once
  })
})
