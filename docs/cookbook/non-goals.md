# Recipe: Non-goals & bring-your-own

**Problem:** you reach for Kata's built-in persistence layer, rate limiter,
metrics exporter, config loader, or pagination helper — and there isn't one. Is
that a gap?

**Pattern:** no — it's the boundary. Kata owns the request: typed routing,
mandatory `input` / `output` validation, dependency injection, the error
envelope, and the lifecycle. *Infrastructure* and *product policy* — how you
store data, throttle traffic, measure, configure, and page — stay yours, so the
framework never locks you into a vendor or a shape. This is the v0.3 line on
purpose: persistence, rate-limit, metrics, env, and pagination are
**bring-your-own (BYO)**, not missing features. Below is the idiomatic BYO for
each, and the lever it leans on.

Every snippet here uses only Kata's shipped surface
([`packages/kata/src/index.ts`](../../packages/kata/src/index.ts)) and the
runnable [`examples/shop`](../../examples/shop) / [`examples/hello`](../../examples/hello)
apps. Where a recipe leans on planned API, it is labelled _Planned_ with its
tracking issue — never assume planned API works yet.

## The boundary

| Kata owns (in the box) | You bring (BYO) |
|---|---|
| Typed routing; per-route `input` / `output` Zod schemas ([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)) | Persistence (SQL / NoSQL) |
| DI — `singleton` / `scoped` slots in one `defineContext` ([ADR-0004](../adr/0004-di-via-scoped-slots.md)) | Rate limiting / throttling |
| The unified error envelope + global error boundary ([ADR-0008](../adr/0008-unified-error-response-envelope.md)) | Metrics / tracing |
| Request lifecycle — `x-request-id`, the per-request log line | Env / config validation |
| Hono-wrapped hardening: `cors()`, `secureHeaders()`, `bodyLimit()` | Pagination / filtering / sorting |

Every BYO row uses one of three levers you already have:

- **A singleton slot** — a long-lived client (pool, SDK, exporter), one per
  process; `c.get('key')` returns the same instance everywhere ([database.md](./database.md)).
- **A scoped slot** — per-request state (a transaction, a span), set by a
  middleware ([auth.md](./auth.md)).
- **A Hono middleware** — `createApp` returns a plain Hono app, so
  `app.use('*', mw)` applies any Hono middleware app-wide, today.

None of these is a framework feature you're waiting on. That's the point: the
core stays small and statically verifiable, and the choices that depend on your
infrastructure stay with you.

## 1. Persistence (SQL / NoSQL)

**Pattern:** the connection pool / client is a **singleton**; a transaction is a
**scoped** slot, opened and committed (or rolled back) by a middleware. It is the
same two-lifetime split as [database.md](./database.md) — `c.get('store')` is the
long-lived pool, `c.get('tx')` is this request's transaction — and it ships
runnable in [`examples/shop`](../../examples/shop), where checkout decrements
stock, writes the order, and clears the cart atomically.

```ts
// examples/shop/src/context.ts (excerpt)
export const k = defineContext({
  store: singleton<Store>(createStore()), // pool / client — one per process
  tx: scoped<Transaction>(),              // one transaction per request
})
```

The middleware opens the transaction off the singleton, provides it as a scoped
slot, and guarantees rollback on any path that doesn't commit:

```ts
// examples/shop/src/middlewares/transaction.ts
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
    // Reached only if the handler returned without committing (e.g. c.error).
    if (tx.status === 'open') tx.rollback()
  },
})
```

Attach it to the routes that need a transaction; the handler reads `c.get('tx')`,
stages its writes, and commits on success:

```ts
// examples/shop/src/modules/orders/orders.route.ts (excerpt)
export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction], // order is the contract — auth, then tx
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx')
    const result = checkout(tx, c.get('currentUser').id)
    // ...commit on success; an error response lets the middleware roll back.
  },
})
```

**Your driver, your call.** Anything exposing a pool plus a
`begin / commit / rollback` surface drops into this shape:

| Driver | Fit |
|---|---|
| `node-postgres` (`pg`), `postgres.js` | ideal — a plain pool with explicit `BEGIN` / `COMMIT` |
| Drizzle, Kysely | ideal — typed query builders; `db.transaction(...)` maps onto the scoped slot |
| Prisma | works — pass the `prisma.$transaction(...)` client through the `tx` slot |
| TypeORM, MikroORM | work, but their decorator/entity model rubs against [ADR-0002](../adr/0002-no-classes-no-decorators.md) — prefer a non-decorator driver |

> NoSQL is the same rule: the connection is a singleton, and request-scoped
> handles (a MongoDB session, a Redis `MULTI`) are scoped slots set by a
> middleware. The lifetime model — not SQL — is what Kata standardises.

See [database.md](./database.md) for the full singleton + pure-service
walkthrough, and the
[`examples/shop` transaction middleware](../../examples/shop/src/middlewares/transaction.ts)
for the complete commit/rollback wiring.

## 2. Rate limiting / throttling

**Pattern:** a Hono middleware. Throttling is cross-cutting and backend-specific
(in-memory for one node, Redis for a fleet, or the gateway in front of you), so
Kata ships no limiter — you pick the store and apply a Hono middleware on the app
`createApp` returns. App-wide is usually exactly where you want it:

```ts
// src/main.ts
import { serve } from '@hono/node-server'
import { rateLimiter } from 'hono-rate-limiter' // e.g. — pick your limiter + store

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })

// Applies to every route — plain Hono on the app Kata hands back.
app.use('*', rateLimiter({ windowMs: 60_000, limit: 100 }))

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })
```

Kata's own `cors()`, `secureHeaders()`, and `bodyLimit()`
([`packages/kata/src/middlewares/`](../../packages/kata/src/middlewares)) show the
shape — Hono middleware adapted to Kata's `Middleware` contract — and a limiter you
wrap the same way slots in beside them: in a single route's `use:` chain, or, for an
app-wide limit, in the global `createApp({ middlewares })` chain
([ADR-0012](../adr/0012-app-level-middleware.md)).

> **Shipped:** the app-level middleware API has landed
> ([Epic #84](https://github.com/VicenzoMF/kata/issues/84),
> [ADR-0012](../adr/0012-app-level-middleware.md)) — declare cross-cutting concerns
> once in `createApp({ middlewares: [...] })` and they run before every route's
> `use:`. A Kata-native limiter (a `Middleware` value) drops straight in;
> `app.use('*', …)` on the returned Hono instance still works for arbitrary Hono
> middleware.

## 3. Metrics / tracing

**Pattern:** the same app-level seam, pointed at whatever backend you already run
(OpenTelemetry, Prometheus, Datadog…). Kata stays vendor-neutral and gives you
two hooks instead of a fixed exporter:

```ts
// src/main.ts
import { otel } from '@hono/otel' // e.g. — any Hono instrumentation middleware

const app = createApp({ modules: [users] })
app.use('*', otel()) // a span per request to your configured exporter
```

- **The exporter/SDK is a singleton.** Build the metrics client (an OTLP
  exporter, a StatsD socket) once in `defineContext` and `c.get('metrics')` in
  handlers for custom counters — the same process-lifetime rule as the DB pool
  ([database.md](./database.md#why-singleton-not-scoped)).
- **Correlation is already wired.** Kata reuses an inbound `x-request-id` (set by
  your proxy or gateway) or mints one, echoes it on the response, and tags the
  per-request log line with it (`REQUEST_ID_HEADER`). Send that header at your
  edge and your traces, logs, and Kata's own log line all share one id — no
  second correlation id to invent.

## 4. Env / config validation

**Pattern:** there is nothing to ship — config validation *is* Zod, which Kata
already depends on. Parse `process.env` once, at the edge, into a typed object;
import that object everywhere instead of touching `process.env` again.

```ts
// src/env.ts
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

// Throws at import time with a precise message if the environment is wrong.
export const env = EnvSchema.parse(process.env)
```

```ts
// src/context.ts
import { env } from './env'

export const k = defineContext({
  db: singleton(makeDb(env)), // typed config in; handlers never read process.env
})
```

Why a one-liner is enough:

- **Fail fast.** `.parse` throws before the server binds a port — a missing var
  is a startup crash, not a 3 a.m. `undefined`.
- **Typed everywhere.** `env.PORT` is `number`, `env.DATABASE_URL` is `string` —
  the same inference you get on a route's `input`.
- **One source of truth.** Read at the edge, pass values down; services and
  handlers stay pure and testable (the rule from
  [database.md](./database.md#gotchas)).
- **Coercion is built in.** `z.coerce.number()`, `.default()`, and `.enum()`
  handle the all-strings reality of `process.env`.

It is the same library and the same idiom Kata already mandates for request
`input` ([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)), applied to
the environment instead of the body.

## 5. Pagination, filtering, sorting

**Pattern:** an application concern, not a framework one. A list endpoint declares
its query contract as an `input.query` schema, and a **pure service** applies it —
exactly like any other route. There is no `@Paginate()` decorator because there
is nothing for the framework to decide: the shape of a page is your product's
call. [`examples/shop`](../../examples/shop) already does the filtering half:

```ts
// examples/shop/src/modules/products/products.schema.ts
export const ListProductsQuerySchema = z.object({
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
})
```

```ts
// examples/shop/src/modules/products/products.route.ts
export const listProductsRoute = defineRoute({
  method: 'GET',
  path: '/products',
  input: { query: ListProductsQuerySchema },
  output: ProductListSchema,
  handler: (c) => listProducts(c.get('store'), { inStock: c.input.query.inStock }),
})
```

Pagination and sorting are the same shape with more fields — add them to the
query schema, return a page envelope, and let the pure service translate them
into your driver's `LIMIT` / `WHERE` / `ORDER BY`:

```ts
// add to the query DTO — keyset pagination + a whitelisted sort
export const ListProductsQuerySchema = z.object({
  inStock: z.enum(['true', 'false']).optional().transform(/* …as above… */),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  sort: z.enum(['price', '-price', 'name']).default('name'),
})

export const ProductPageSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
})
```

You inherit the framework's guarantees for free: the query is validated and
coerced before the handler runs, the page shape is validated on the way out
([ADR-0009](../adr/0009-output-validation-mode.md)), and the whole thing is typed
end-to-end for the `hc` RPC client. Offset, keyset, or page-number — choose per
endpoint; Kata only insists the contract is declared.

## The same boundary, elsewhere

The five above are the common ones, but the rule generalises: if a concern is
about *infrastructure or product policy* rather than *the shape of a request*,
Kata leaves it to you.

- **OpenAPI / API documentation.** Every route already carries Zod `input` /
  `output` schemas, so an OpenAPI document is a generation step over data Kata
  already holds — not a roadmap gap. Feed those schemas to a generator (e.g.
  `@asteasolutions/zod-to-openapi` or `@hono/zod-openapi`) and serve the result
  as a route or via `app.use`. Kata deliberately doesn't bundle a generator or
  own your docs pipeline. (This is the BYO reading of the OpenAPI row in
  [migrating-from-nestjs.md](./migrating-from-nestjs.md#what-kata-intentionally-does-not-have).)
- **Background jobs / queues, email, file storage, feature flags** — same story:
  a singleton client in `defineContext`, consumed from pure services.

## See also

- [Database access](./database.md) — singletons, scoped transactions, pure
  services, fake-client tests.
- [Authentication](./auth.md) — the scoped-slot mechanism the BYO patterns reuse.
- [Migrating from NestJS to Kata](./migrating-from-nestjs.md) — what else Kata
  intentionally does not have, and why.
- [`examples/shop`](../../examples/shop) — the runnable transaction + query-filter
  source this page quotes.
- ADRs: [0002 (no classes/decorators)](../adr/0002-no-classes-no-decorators.md),
  [0003 (mandatory schemas)](../adr/0003-mandatory-input-output-schemas.md),
  [0004 (DI via slots)](../adr/0004-di-via-scoped-slots.md),
  [0012 (app-level middleware)](../adr/0012-app-level-middleware.md).
