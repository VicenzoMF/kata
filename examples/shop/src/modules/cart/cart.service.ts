import type { Store } from '../../store'

import type { AddCartItemBody, Cart, CartLine } from './cart.schema'

export type AddItemResult = { ok: true; cart: Cart } | { ok: false; error: 'product_not_found' }

export function readCart(store: Store, userId: string): Cart {
  return toCart(userId, store.getCart(userId))
}

export function addItem(store: Store, userId: string, input: AddCartItemBody): AddItemResult {
  const product = store.getProduct(input.productId)
  if (!product) return { ok: false, error: 'product_not_found' }

  const lines = [...store.getCart(userId)]
  const index = lines.findIndex((line) => line.productId === product.id)
  if (index >= 0) {
    const existing = lines[index]!
    lines[index] = { ...existing, qty: existing.qty + input.qty }
  } else {
    lines.push({
      productId: product.id,
      name: product.name,
      unitPriceCents: product.priceCents,
      qty: input.qty,
    })
  }
  store.setCart(userId, lines)
  return { ok: true, cart: toCart(userId, lines) }
}

export function removeItem(store: Store, userId: string, productId: string): Cart {
  const lines = store.getCart(userId).filter((line) => line.productId !== productId)
  store.setCart(userId, lines)
  return toCart(userId, lines)
}

function toCart(userId: string, lines: CartLine[]): Cart {
  const totalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0)
  return { userId, lines, totalCents }
}
