import { z } from 'zod'

export const EchoBodySchema = z.object({
  message: z.string().min(1),
})

export const EchoResponseSchema = z.object({
  echoed: z.string(),
})

export type EchoBody = z.infer<typeof EchoBodySchema>
export type EchoResponse = z.infer<typeof EchoResponseSchema>
