import { defineMiddleware } from '../context'

/**
 * Toy auth: reads `x-user-id` and provides the `currentUser` scoped slot.
 * Reused across the cart and orders modules (and product creation) — the same
 * middleware instance composed into many routes, no per-route duplication.
 * Replace with real JWT / session decoding in any real app.
 */
export const requireAuth = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const userId = c.header('x-user-id')
    if (!userId) return c.error('unauthorized', 'Missing x-user-id header', { status: 401 })

    c.set('currentUser', { id: userId })
    await next()
  },
})
