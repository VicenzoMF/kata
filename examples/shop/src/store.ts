import type { CartLine } from './modules/cart/cart.schema'
import type { Order } from './modules/orders/orders.schema'
import type { Product } from './modules/products/products.schema'

/**
 * In-memory persistence stub for the shop example — the "db client" registered
 * as a singleton in `defineContext`. Real apps swap this for a database; the
 * route/service code above it does not change.
 */
export type Store = {
  listProducts(): Product[]
  getProduct(id: string): Product | undefined
  putProduct(product: Product): void
  getCart(userId: string): CartLine[]
  setCart(userId: string, lines: CartLine[]): void
  listOrders(userId: string): Order[]
  getOrder(id: string): Order | undefined
  putOrder(order: Order): void
  /** Open a unit of work. See {@link Transaction}. */
  begin(): Transaction
  /**
   * Release the backing resources. The in-memory stub just drops its data; a
   * real driver would `await pool.end()` here. Wired into `gracefulShutdown`'s
   * `onClose` in `main.ts` (ADR-0014) so a `SIGTERM` drains in-flight requests
   * first, then closes the store. Idempotent — safe to call more than once.
   */
  close(): Promise<void>
}

export type TransactionStatus = 'open' | 'committed' | 'rolled-back'

/**
 * Outcome of {@link Transaction.commit}. `{ ok: false }` means the commit was
 * refused because a product this transaction read was changed by a concurrent
 * writer between read and commit (an optimistic-concurrency conflict); the
 * staged writes are discarded rather than overwriting the other writer.
 */
export type CommitResult = { ok: true } | { ok: false; conflict: string }

/**
 * A per-request unit of work over the {@link Store} — the scoped slot from
 * ADR-0004. Reads see the committed store *plus* this transaction's own staged
 * writes; writes are buffered and only flushed to the store by {@link commit},
 * in a single synchronous pass. If `commit` is never called the staged writes
 * are discarded, so a handler that fails partway never persists a partial
 * change.
 *
 * `commit` is also optimistic: it refuses (returns `{ ok: false }`) if a product
 * this transaction read was changed underneath it, so two concurrent checkouts
 * can never both decrement the same unit (no lost update / oversell) — a
 * guarantee that survives swapping this stub for a real async datastore. The
 * orders module uses this to make checkout atomic.
 */
export type Transaction = {
  readonly id: string
  readonly status: TransactionStatus
  getProduct(id: string): Product | undefined
  getCart(userId: string): CartLine[]
  putProduct(product: Product): void
  putOrder(order: Order): void
  setCart(userId: string, lines: CartLine[]): void
  /**
   * Flush staged writes atomically. Returns `{ ok: false, conflict }` instead of
   * overwriting a concurrent change. Throws only if already settled.
   */
  commit(): CommitResult
  /** Discard staged writes. Safe to call on an already-settled transaction. */
  rollback(): void
}

type StoreData = {
  products: Map<string, Product>
  carts: Map<string, CartLine[]>
  orders: Map<string, Order>
}

/** Seed catalog so `GET /products` and the hurl suite have data on a fresh boot. */
export const DEMO_CATALOG: readonly Product[] = [
  { id: 'prod-keyboard', name: 'Mechanical Keyboard', priceCents: 12000, stock: 5 },
  { id: 'prod-mouse', name: 'Wireless Mouse', priceCents: 4500, stock: 10 },
  { id: 'prod-monitor', name: 'Ultrawide Monitor', priceCents: 30000, stock: 0 },
]

function createTransaction(data: StoreData): Transaction {
  const stagedProducts = new Map<string, Product>()
  const stagedCarts = new Map<string, CartLine[]>()
  const stagedOrders = new Map<string, Order>()
  // Committed `stock` each product had when this tx first read it. commit() uses
  // it for the optimistic-concurrency check below.
  const readVersions = new Map<string, number>()
  let status: TransactionStatus = 'open'

  const assertOpen = (): void => {
    if (status !== 'open') {
      throw new Error(`kata-shop: transaction already ${status}`)
    }
  }

  return {
    id: crypto.randomUUID(),
    get status() {
      return status
    },
    getProduct: (id) => {
      const committed = data.products.get(id)
      if (committed && !readVersions.has(id)) readVersions.set(id, committed.stock)
      return stagedProducts.get(id) ?? committed
    },
    getCart: (userId) =>
      stagedCarts.has(userId) ? (stagedCarts.get(userId) ?? []) : (data.carts.get(userId) ?? []),
    putProduct: (product) => {
      assertOpen()
      stagedProducts.set(product.id, product)
    },
    putOrder: (order) => {
      assertOpen()
      stagedOrders.set(order.id, order)
    },
    setCart: (userId, lines) => {
      assertOpen()
      stagedCarts.set(userId, lines)
    },
    commit: () => {
      assertOpen()
      // Invariant: never persist negative stock (a staging bug, not a race).
      for (const product of stagedProducts.values()) {
        if (product.stock < 0) {
          throw new Error(`kata-shop: refusing to commit negative stock for '${product.id}'`)
        }
      }
      // Optimistic concurrency: if a product we read was changed by another
      // committed transaction since, our staged write is based on a stale value
      // — abort instead of overwriting it (which would oversell).
      for (const product of stagedProducts.values()) {
        const base = readVersions.get(product.id)
        if (base !== undefined && data.products.get(product.id)?.stock !== base) {
          stagedProducts.clear()
          stagedCarts.clear()
          stagedOrders.clear()
          status = 'rolled-back'
          return { ok: false, conflict: product.id }
        }
      }
      for (const [id, product] of stagedProducts) data.products.set(id, product)
      for (const [userId, lines] of stagedCarts) data.carts.set(userId, lines)
      for (const [id, order] of stagedOrders) data.orders.set(id, order)
      status = 'committed'
      return { ok: true }
    },
    rollback: () => {
      if (status !== 'open') return
      stagedProducts.clear()
      stagedCarts.clear()
      stagedOrders.clear()
      status = 'rolled-back'
    },
  }
}

export function createStore(seed: readonly Product[] = DEMO_CATALOG): Store {
  const data: StoreData = {
    products: new Map(seed.map((product) => [product.id, { ...product }])),
    carts: new Map(),
    orders: new Map(),
  }
  let closed = false

  return {
    listProducts: () => [...data.products.values()],
    getProduct: (id) => data.products.get(id),
    putProduct: (product) => {
      data.products.set(product.id, product)
    },
    getCart: (userId) => data.carts.get(userId) ?? [],
    setCart: (userId, lines) => {
      data.carts.set(userId, lines)
    },
    listOrders: (userId) => [...data.orders.values()].filter((order) => order.userId === userId),
    getOrder: (id) => data.orders.get(id),
    putOrder: (order) => {
      data.orders.set(order.id, order)
    },
    begin: () => createTransaction(data),
    close: async () => {
      if (closed) return
      closed = true
      // A real pool awaits in-flight queries and tears down its sockets here;
      // the stub just releases its in-memory data so `onClose` has work to do.
      data.products.clear()
      data.carts.clear()
      data.orders.clear()
    },
  }
}
