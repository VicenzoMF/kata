---
title: Services
description: Business logic lives in pure functions with no framework imports — trivially unit-testable, called from route handlers.
---

# Services

A service is where your business logic lives. It sits in `<domain>.service.ts` and
is made of plain functions — and, crucially, it imports *nothing* from the
framework: no `katajs`, no Hono, no `defineContext`, no `defineRoute`, no `c`. A route
handler validates the input, calls a service, and returns the result. The service
itself has no idea it is being served over HTTP.

That separation is the whole point of the locked layout, and it sorts each domain's
files by responsibility:

- the **route** is the *contract* (method, path, input/output);
- the **service** is the *logic*;
- the **schema** is the *shape*.

Each is findable by glob and testable on its own.

Why insist that the service be framework-free? Because a function whose result
depends only on its arguments — no hidden reads from a container, no reach into
global state — is one you can test by just calling it, and reuse anywhere, HTTP or
not. That property has a name — a *pure* function — and most of this page is about
protecting it.

## A service is just functions

The `hello` example keeps its whole user store in one file. Notice what it does
**not** import: nothing from `katajs`, no Hono, no request context.

```ts
// src/modules/users/users.service.ts
import type { CreateUserBody, User } from './users.schema'

const store = new Map<string, User>()

export async function getUser(id: string): Promise<User | null> {
  return store.get(id) ?? null
}

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  store.set(id, user)
  return user
}
```

The only imports are *types* from the sibling `<domain>.schema.ts`. The functions
take and return those typed DTOs, and that is the entire dependency surface — types
vanish at compile time, so importing them ties the service to nothing concrete at
runtime.

::: tip Named exports, no classes
Services are functions, not methods on a class
([ADR-0002](/adr/0002-no-classes-no-decorators)). Export each one by name. There is
no service object to instantiate and no `this` to bind.
:::

## How routes call services

Think of the handler as a thin adapter between HTTP and your logic. The route owns
the HTTP concerns — method, path, `input`, `output`, status codes — and hands the
actual work to the service. The handler reads the already-validated `c.input`, calls
the service, and returns the value (which Kata then validates against `output`):

```ts
// src/modules/users/users.route.ts
import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
```

Read top to bottom, each handler is three steps: unwrap `c.input`, call the service,
map the result onto a response. Keep validation in the schemas and logic in the
service, and the handler has almost nothing left to get wrong. See
[Routes & schemas](/guide/routes-schemas) for the full route surface.

## Dependencies are arguments, not imports

The `hello` store is a module-level `Map` — fine for a demo, but a real service needs
a database. Here is the tension: the database lives in the DI container, yet a service
that reaches into the container is no longer pure. Kata resolves it with one rule:
**a service never calls `c.get(...)`.** Instead it *receives* its dependencies as
ordinary arguments, and the route — which does have `c` — pulls them from the context
and passes them in.

This is dependency inversion stated plainly: the service's signature says "I need a
`Store`," and the *caller* decides which `Store` that is. The service commits to an
interface, never to a concrete implementation.

The `shop` example does exactly this. Its order service takes a `Store` (or a
per-request `Transaction`) as its first parameter:

```ts
// src/modules/orders/orders.service.ts
import type { Store, Transaction } from '../../store'

import type { Order } from './orders.schema'

export function listOrders(store: Store, userId: string): Order[] {
  return store.listOrders(userId)
}

export function getOrder(store: Store, userId: string, id: string): Order | undefined {
  const order = store.getOrder(id)
  if (!order || order.userId !== userId) return undefined
  return order
}
```

The route is where the wiring happens. `store` is a singleton slot in
`defineContext`; the handler reads it with `c.get('store')` and hands it to the
service:

```ts
// src/modules/orders/orders.route.ts
export const listOrdersRoute = defineRoute({
  method: 'GET',
  path: '/orders',
  use: [requireAuth],
  input: {},
  output: OrderListSchema,
  handler: (c) => listOrders(c.get('store'), c.get('currentUser').id),
})
```

So `c.get('store')` and `c.get('currentUser')` stay in the handler, where the context
actually exists; the service sees only a `Store` and a `userId`. The payoff lands
when you swap the in-memory store for a real database: the service signature does not
change at all — only the singleton you register does.

## Return results, not responses

A service has no `c`, so it cannot call `c.json(...)` or `c.error(...)` — and that is
a feature, not a limitation. HTTP status codes are a transport detail; the service's
job is to report *what happened* and let the route decide how that maps onto the
wire.

When an operation can fail in a way the caller must branch on, the idiomatic move is
to return a **discriminated union** — a type that is one of several named shapes, each
tagged by a shared field (here `ok`, plus an `error` code on the failures). The caller
switches on that tag, and TypeScript makes sure every case is handled.

`shop`'s `checkout` returns one:

```ts
// src/modules/orders/orders.service.ts
export type CheckoutResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'cart_empty' }
  | { ok: false; error: 'product_unavailable'; productId: string }
  | {
      ok: false
      error: 'insufficient_stock'
      productId: string
      available: number
      requested: number
    }

export function checkout(tx: Transaction, userId: string): CheckoutResult {
  const cartLines = tx.getCart(userId)
  if (cartLines.length === 0) return { ok: false, error: 'cart_empty' }
  // ... stage stock decrements, build the order ...
  return { ok: true, order }
}
```

The handler maps that union onto the wire — success to `201`, each failure to its
status via the unified error envelope
([ADR-0008](/adr/0008-unified-error-response-envelope)):

```ts
// src/modules/orders/orders.route.ts
handler: (c) => {
  const tx = c.get('tx')
  const result = checkout(tx, c.get('currentUser').id)
  if (!result.ok) {
    const envelope = describeCheckoutFailure(result)
    return c.error(envelope.code, envelope.message, { status: envelope.status })
  }
  const committed = tx.commit()
  if (!committed.ok) {
    return c.error(
      'stock_conflict',
      `Stock for "${committed.conflict}" changed during checkout — please retry`,
      { status: 409 },
    )
  }
  return c.json(result.order, 201)
}
```

The mapping itself — `describeCheckoutFailure` — is *also* a pure function in the same
service, so even the error contract is unit-testable, with no `c` in sight. The
HTTP-specific bits (`c.error`, the literal `201`) are the only things that stay in the
route. See [Errors](/guide/errors) for the envelope.

## Services are trivially testable

Everything above pays off here. Because a service imports no framework and takes its
dependencies as arguments, a test just imports the functions and calls them — no app
to boot, no request to fake, no mock of `c`. The test file is
`<domain>.service.test.ts`, sitting right beside the service.

The `hello` service test calls the real functions directly:

```ts
// src/modules/users/users.service.test.ts
import { describe, expect, it } from 'vitest'

import { createUser, getUser } from './users.service'

describe('users.service', () => {
  it('createUser persists and returns the user with a uuid id', async () => {
    const user = await createUser({ name: 'Alice', email: 'a@example.com' })
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(user.name).toBe('Alice')
    expect(user.email).toBe('a@example.com')
  })

  it('getUser returns null for unknown ids', async () => {
    expect(await getUser('does-not-exist')).toBeNull()
  })
})
```

When a service takes a dependency, the test constructs a *real* one and passes it in
— no mocking framework required. `shop`'s test builds an in-memory store with a seed
catalog, then asserts on both the returned union and the store's state:

```ts
// src/modules/orders/orders.service.test.ts
import { describe, expect, it } from 'vitest'

import { createStore } from '../../store'
import { addItem } from '../cart/cart.service'
import { checkout, listOrders } from './orders.service'

describe('orders.service checkout', () => {
  it('decrements stock, creates an order, and clears the cart on commit', () => {
    const store = createStore([{ id: 'mouse', name: 'Mouse', priceCents: 4500, stock: 10 }])
    addItem(store, 'u1', { productId: 'mouse', qty: 2 })

    const tx = store.begin()
    const result = checkout(tx, 'u1')
    if (!result.ok) throw new Error('expected ok')
    tx.commit()

    expect(result.order.totalCents).toBe(2 * 4500)
    expect(store.getProduct('mouse')?.stock).toBe(8)
    expect(listOrders(store, 'u1').map((o) => o.id)).toEqual([result.order.id])
  })

  it('rejects an empty cart', () => {
    expect(checkout(createStore([]).begin(), 'u1')).toEqual({ ok: false, error: 'cart_empty' })
  })
})
```

The whole business rule — stock decrement, atomic checkout, ownership, the error
envelope — is exercised without ever touching HTTP. Run it with `pnpm test`.

::: info Pure by construction
Keeping `c.get(...)` in the route and out of the service is exactly what makes this
possible. If a service reached into the container, you would have to fake the
container to test it. Passing the dependency in keeps every test a plain function
call.
:::

## Persistence is bring-your-own

Kata ships no database layer, no ORM, and no query helpers — persistence is a
deliberate non-goal ([Non-goals](/cookbook/non-goals)). Both examples use an
in-memory store as a stand-in. The pattern that keeps the eventual swap painless is
the one from above: model your data access as a typed client, register it as a
`singleton` slot, and pass it into services as an argument.

So when you replace the in-memory `Store` with node-postgres, Drizzle, Prisma, or
anything else, only the singleton you register in `defineContext` changes — every
service signature and every route handler stays put. The full recipe is in
[Database](/cookbook/database).

## Rules

- A service imports types from `<domain>.schema.ts` and other services. Nothing from
  `katajs`, Hono, or the request context.
- A service never calls `c.get(...)`, `c.json(...)`, or `c.error(...)`. It takes
  dependencies as arguments and returns plain values or typed result unions.
- Services are functions with named exports — no classes, no `this`
  ([ADR-0002](/adr/0002-no-classes-no-decorators)).
- Every service has a sibling `<domain>.service.test.ts`. It should run without
  booting the app.

See also: [Routes & schemas](/guide/routes-schemas),
[Context & DI](/guide/context-di), [Project layout](/guide/project-layout).
