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

/**
 * The buffered writes + read snapshot a single {@link Transaction} accumulates
 * before {@link Transaction.commit} flushes them. Reads consult `staged*`
 * first, falling back to the committed store; `readVersions` records the
 * committed `stock` each product had when this tx first read it, which
 * {@link detectConflict} compares against at commit time.
 */
type TransactionState = {
  stagedProducts: Map<string, Product>
  stagedCarts: Map<string, CartLine[]>
  stagedOrders: Map<string, Order>
  readVersions: Map<string, number>
}

function createTransactionState(): TransactionState {
  return {
    stagedProducts: new Map(),
    stagedCarts: new Map(),
    stagedOrders: new Map(),
    readVersions: new Map(),
  }
}

/** Drop every staged write — used by rollback and by an aborted commit. */
function clearStaged(state: TransactionState): void {
  state.stagedProducts.clear()
  state.stagedCarts.clear()
  state.stagedOrders.clear()
}

/**
 * Optimistic-concurrency check: returns the id of the first staged product
 * whose committed `stock` changed since this tx read it — meaning the staged
 * write is based on a stale value and would overwrite (oversell) a concurrent
 * commit. Returns `null` when every read is still current and the commit is
 * safe to flush.
 */
function detectConflict(state: TransactionState, data: StoreData): string | null {
  for (const product of state.stagedProducts.values()) {
    const base = state.readVersions.get(product.id)
    if (base !== undefined && data.products.get(product.id)?.stock !== base) {
      return product.id
    }
  }
  return null
}

/** Apply every staged write to the committed store in a single synchronous pass. */
function flushStaged(state: TransactionState, data: StoreData): void {
  for (const [id, product] of state.stagedProducts) data.products.set(id, product)
  for (const [userId, lines] of state.stagedCarts) data.carts.set(userId, lines)
  for (const [id, order] of state.stagedOrders) data.orders.set(id, order)
}

function createTransaction(data: StoreData): Transaction {
  const state = createTransactionState()
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
      if (committed && !state.readVersions.has(id)) state.readVersions.set(id, committed.stock)
      return state.stagedProducts.get(id) ?? committed
    },
    getCart: (userId) =>
      state.stagedCarts.has(userId)
        ? (state.stagedCarts.get(userId) ?? [])
        : (data.carts.get(userId) ?? []),
    putProduct: (product) => {
      assertOpen()
      state.stagedProducts.set(product.id, product)
    },
    putOrder: (order) => {
      assertOpen()
      state.stagedOrders.set(order.id, order)
    },
    setCart: (userId, lines) => {
      assertOpen()
      state.stagedCarts.set(userId, lines)
    },
    commit: () => {
      assertOpen()
      // Invariant: never persist negative stock (a staging bug, not a race).
      for (const product of state.stagedProducts.values()) {
        if (product.stock < 0) {
          throw new Error(`kata-shop: refusing to commit negative stock for '${product.id}'`)
        }
      }
      // Optimistic concurrency: abort instead of overwriting a product another
      // transaction committed since we read it (which would oversell).
      const conflict = detectConflict(state, data)
      if (conflict !== null) {
        clearStaged(state)
        status = 'rolled-back'
        return { ok: false, conflict }
      }
      flushStaged(state, data)
      status = 'committed'
      return { ok: true }
    },
    rollback: () => {
      if (status !== 'open') return
      clearStaged(state)
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
