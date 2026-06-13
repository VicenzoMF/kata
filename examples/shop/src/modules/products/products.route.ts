import { z } from 'zod'

import { defineRoute } from '../../context'
import { requireAuth } from '../../middlewares/auth'

import {
  CreateProductBodySchema,
  ListProductsQuerySchema,
  ProductListSchema,
  ProductSchema,
} from './products.schema'
import { createProduct, getProduct, listProducts } from './products.service'

export const listProductsRoute = defineRoute({
  method: 'GET',
  path: '/products',
  input: { query: ListProductsQuerySchema },
  output: ProductListSchema,
  handler: (c) => listProducts(c.get('store'), { inStock: c.input.query.inStock }),
})

export const getProductRoute = defineRoute({
  method: 'GET',
  path: '/products/:id',
  input: { params: z.object({ id: z.string() }) },
  output: ProductSchema,
  handler: (c) => {
    const product = getProduct(c.get('store'), c.input.params.id)
    if (!product) return c.error('not_found', 'Product not found', { status: 404 })
    return product
  },
})

// Creating a product requires auth — the same `requireAuth` middleware the cart
// and orders modules use. A real shop would additionally gate this on a role.
export const createProductRoute = defineRoute({
  method: 'POST',
  path: '/products',
  use: [requireAuth],
  input: { body: CreateProductBodySchema },
  output: ProductSchema,
  handler: (c) => createProduct(c.get('store'), c.input.body),
})
