import { z } from 'zod'

export const RequestIdResponseSchema = z.object({
  requestId: z.string(),
})

export type RequestIdResponse = z.infer<typeof RequestIdResponseSchema>
