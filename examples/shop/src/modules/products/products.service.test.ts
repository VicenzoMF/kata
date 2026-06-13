import { describe, expect, it } from 'vitest'

import { createStore } from '../../store'

import { createProduct, getProduct, listProducts } from './products.service'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('products.service', () => {
  it('listProducts returns everything when unfiltered', () => {
    const store = createStore([
      { id: 'a', name: 'A', priceCents: 100, stock: 3 },
      { id: 'b', name: 'B', priceCents: 200, stock: 0 },
    ])
    expect(listProducts(store, {}).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('listProducts filters by stock availability', () => {
    const store = createStore([
      { id: 'a', name: 'A', priceCents: 100, stock: 3 },
      { id: 'b', name: 'B', priceCents: 200, stock: 0 },
    ])
    expect(listProducts(store, { inStock: true }).map((p) => p.id)).toEqual(['a'])
    expect(listProducts(store, { inStock: false }).map((p) => p.id)).toEqual(['b'])
  })

  it('createProduct assigns a uuid id and persists', () => {
    const store = createStore([])
    const created = createProduct(store, { name: 'New', priceCents: 999, stock: 7 })
    expect(created.id).toMatch(UUID)
    expect(getProduct(store, created.id)).toEqual(created)
  })

  it('getProduct returns undefined for unknown ids', () => {
    expect(getProduct(createStore([]), 'nope')).toBeUndefined()
  })
})
