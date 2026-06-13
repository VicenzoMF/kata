import { defineMiddleware } from '../context'

/**
 * Opens a {@link Transaction} from the store singleton and provides it as the
 * `tx` scoped slot (ADR-0004). The handler stages its writes on `tx` and calls
 * `tx.commit()` on success. Anything else — an early error response, a thrown
 * exception, or simply forgetting to commit — leaves `tx` un-committed, and
 * this middleware rolls it back so no partial write reaches the store.
 */
export const withTransaction = defineMiddleware({
  provides: ['tx'] as const,
  handler: async (c, next) => {
    const tx = c.get('store').begin()
    c.set('tx', tx)
    try {
      await next()
    } catch (err) {
      tx.rollback()
      throw err
    }
    // Reached only when the handler returned without committing (e.g. it
    // short-circuited with c.error). rollback() is a no-op once committed.
    if (tx.status === 'open') tx.rollback()
  },
})
