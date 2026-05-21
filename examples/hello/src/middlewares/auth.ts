import { defineMiddleware } from '../context'

/**
 * Toy auth: reads `x-user-id` header and synthesizes a User.
 * Replace with real JWT / session decoding in any real app.
 */
export const fakeAuth = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const userId = c.header('x-user-id')
    if (!userId) return c.json({ error: 'unauthorized' }, 401)

    c.set('currentUser', {
      id: userId,
      name: `User-${userId}`,
      email: `user-${userId}@example.test`,
    })
    await next()
  },
})
