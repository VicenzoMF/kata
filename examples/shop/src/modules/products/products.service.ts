import type { Store } from '../../store'

import type { CreateProductBody, Product } from './products.schema'

export function listProducts(store: Store, filter: { inStock?: boolean }): Product[] {
  const all = store.listProducts()
  if (filter.inStock === undefined) return all
  return all.filter((product) => (filter.inStock ? product.stock > 0 : product.stock === 0))
}

export function getProduct(store: Store, id: string): Product | undefined {
  return store.getProduct(id)
}

export function createProduct(store: Store, input: CreateProductBody): Product {
  const product: Product = { id: crypto.randomUUID(), ...input }
  store.putProduct(product)
  return product
}
