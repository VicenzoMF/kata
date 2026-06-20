import { z } from 'zod'

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceCents: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
})

export const ProductListSchema = z.array(ProductSchema)

/**
 * Query DTO for `GET /products`. Query values arrive as strings, so `inStock`
 * is parsed from `'true' | 'false'` and transformed into a real boolean (or
 * `undefined` when the filter is omitted).
 */
export const ListProductsQuerySchema = z.object({
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
})

export const CreateProductBodySchema = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
})

export type Product = z.infer<typeof ProductSchema>
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>

export const GetProductParamsSchema = z.object({ id: z.string() })
export type GetProductParams = z.infer<typeof GetProductParamsSchema>
