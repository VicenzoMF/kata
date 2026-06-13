import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const UserListSchema = z.array(UserSchema)

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

export const GetUserParamsSchema = z.object({
  id: z.string(),
})

export const ListUsersQuerySchema = z.object({
  q: z.string().optional(),
})

export type User = z.infer<typeof UserSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
