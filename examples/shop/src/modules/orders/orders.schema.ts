import { z } from 'zod'

export const OrderLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  unitPriceCents: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
})

export const OrderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  lines: z.array(OrderLineSchema),
  totalCents: z.number().int().nonnegative(),
  status: z.literal('paid'),
  createdAt: z.string().datetime(),
})

export const OrderListSchema = z.array(OrderSchema)

export type OrderLine = z.infer<typeof OrderLineSchema>
export type Order = z.infer<typeof OrderSchema>

export const GetOrderParamsSchema = z.object({ id: z.string() })
export type GetOrderParams = z.infer<typeof GetOrderParamsSchema>
