# shop — multi-domain e-commerce slice

A second Kata example (issue #36) that exercises the framework across more than
one module. Where `examples/hello` shows the basics, this app shows Kata at
realistic scale: three domains sharing one store, a reused auth middleware, and
a per-request **transaction** scoped slot powering an atomic checkout.

## Domains

| Module     | Routes                                                              |
| ---------- | ------------------------------------------------------------------ |
| `products` | `GET /products` · `GET /products/:id` · `POST /products`           |
| `cart`     | `GET /cart` · `POST /cart/items` · `DELETE /cart/items/:productId` |
| `orders`   | `POST /orders` (checkout) · `GET /orders` · `GET /orders/:id`      |

## What it demonstrates

- **Module composition** — `createApp({ modules: [products, cart, orders] })`.
- **A shared singleton** — an in-memory `store` (db stub) registered in
  `defineContext`, injected into services via `c.get('store')`.
- **Middleware reuse** — one `requireAuth` middleware provides the `currentUser`
  scoped slot to product creation, the whole cart module, and the whole orders
  module. No per-route duplication.
- **A transaction scoped slot (ADR-0004)** — `withTransaction` opens a unit of
  work and provides it as the `tx` slot. Checkout stages stock decrements, the
  new order, and the cart clear on `tx`, then commits. Any failure (empty cart,
  missing product, insufficient stock) returns early; the middleware rolls back,
  so a partial order never persists. `commit()` is optimistic — if a concurrent
  checkout changed a product between read and commit, it is refused and the
  loser gets a `409` to retry, so two checkouts can never oversell the same
  unit. See `src/store.ts` and `src/modules/orders/orders.service.ts`.
- **Mandatory input/output schemas (ADR-0003)** and the **unified error
  envelope (ADR-0008)** on every route.

## Run it

```sh
pnpm --filter shop start          # http://localhost:3000
pnpm --filter shop hurl           # API E2E (server must be running)
pnpm --filter shop typecheck
pnpm test                         # unit tests (vitest, from the repo root)
```

Auth is a toy: send `X-User-Id: <id>` to identify the current user.

```sh
curl -s localhost:3000/products
curl -s -X POST localhost:3000/cart/items -H 'x-user-id: alice' \
  -H 'content-type: application/json' -d '{"productId":"prod-mouse","qty":2}'
curl -s -X POST localhost:3000/orders -H 'x-user-id: alice'
```
