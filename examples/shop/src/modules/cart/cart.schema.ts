import { z } from 'zod'

/**
 * A line in a user's cart. Price and name are snapshotted at add-time so the
 * cart total is stable even if the catalog later changes (ADR-0005: DTOs live
 * here, never inline in the route).
 */
export const CartLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  unitPriceCents: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
})

export const CartSchema = z.object({
  userId: z.string(),
  lines: z.array(CartLineSchema),
  totalCents: z.number().int().nonnegative(),
})

export const AddCartItemBodySchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().positive(),
})

export const RemoveCartItemParamsSchema = z.object({
  productId: z.string(),
})

export type CartLine = z.infer<typeof CartLineSchema>
export type Cart = z.infer<typeof CartSchema>
export type AddCartItemBody = z.infer<typeof AddCartItemBodySchema>
