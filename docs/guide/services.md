---
title: Services
description: Business logic lives in pure functions with no framework imports — trivially unit-testable, called from route handlers.
---

# Services

A service holds your business logic. It lives in `<domain>.service.ts` and
contains plain functions — no framework imports, no `defineContext`, no
`defineRoute`, no `c`. A route handler validates input, calls a service, and
returns the result. The service does not know it is being served over HTTP.

This split is the point of the locked layout: the route is the contract, the
service is the logic, the schema is the shape. Each is findable by glob and
testable on its own.

## A service is just functions

The `hello` example keeps its whole user store in one file. Note what it does
**not** import: nothing from `kata`, no Hono, no request context.

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

The only imports are types from the sibling `<domain>.schema.ts`. The functions
take and return those typed DTOs. That is the entire dependency surface.

::: tip Named exports, no classes
Services are functions, not methods on a class ([ADR-0002](/adr/0002-no-classes-no-decorators)).
Export each one by name. There is no service object to instantiate and no `this`
to bind.
:::

## How routes call services

The route owns the HTTP concerns — method, path, `input`, `output`, status
codes — and delegates the work. The handler reads the typed `c.input`, calls the
service, and returns the value (which Kata validates against `output`):

```ts
// src/modules/users/users.route.ts
import { ErrorBodySchema } from 'kata'

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

The handler is a thin adapter: unwrap `c.input`, call the service, map the
result onto a response. Keep validation in the schemas and logic in the service,
and the handler stays small. See [/guide/routes-schemas](/guide/routes-schemas)
for the full route surface.

## Dependencies are arguments, not imports

The `hello` store is a module-level `Map` — fine for a demo, but a real service
needs a database, and a service must stay free of the DI container to stay pure.
The rule: **a service never calls `c.get(...)`.** It receives its dependencies as
arguments. The route pulls them from the context and passes them in.

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

The route wires the dependency in. `store` is a singleton slot in
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

`c.get('store')` and `c.get('currentUser')` live in the handler, where the
context exists. The service sees only a `Store` and a `userId`. Swap the store
for a real database and the service signature does not change — only the
singleton you register does.

## Return results, not responses

A service has no `c`, so it cannot call `c.json(...)` or `c.error(...)`. When an
operation can fail in a way the caller must branch on, return a typed
**discriminated union** and let the route translate it into a status code.

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

The handler maps that union onto the wire — success to `201`, each failure to
its status via the unified error envelope ([ADR-0008](/adr/0008-unified-error-response-envelope)):

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

The mapping itself — `describeCheckoutFailure` — is another pure function in the
same service, so the error contract is unit-testable too. The HTTP-specific
helpers (`c.error`, the `201`) stay in the route. See
[/guide/errors](/guide/errors) for the envelope.

## Services are trivially testable

Because a service imports no framework and takes its dependencies as arguments,
its test imports the functions and calls them. No app to boot, no request to
fake, no mocks of `c`. The test file is `<domain>.service.test.ts`, the sibling
of the service.

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

When a service takes a dependency, the test constructs a real one and passes it
in — no mocking framework required. `shop`'s test builds an in-memory store with
a seed catalog, then asserts on the returned union and the store's state:

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
envelope — is exercised without HTTP. Run it with `pnpm test`.

::: info Pure by construction
Keeping `c.get(...)` in the route and out of the service is what makes this
possible. If a service reached into the container, you would have to fake the
container to test it. Passing the dependency in keeps the test a plain function
call.
:::

## Persistence is bring-your-own

Kata does not ship a database layer, an ORM, or query helpers — persistence is a
non-goal ([/cookbook/non-goals](/cookbook/non-goals)). Both examples use an
in-memory store as a stand-in. The pattern that keeps the swap painless: model
your data access as a typed client, register it as a `singleton` slot, and pass
it into services as an argument.

When you replace the in-memory `Store` with node-postgres, Drizzle, Prisma, or
anything else, only the singleton you register in `defineContext` changes — the
service signatures and the route handlers stay the same. The recipe, end to end,
is in [/cookbook/database](/cookbook/database).

## Rules

- A service imports types from `<domain>.schema.ts` and other services. Nothing
  from `kata`, Hono, or the request context.
- A service never calls `c.get(...)`, `c.json(...)`, or `c.error(...)`. It takes
  dependencies as arguments and returns plain values or typed result unions.
- Services are functions with named exports — no classes, no `this`
  ([ADR-0002](/adr/0002-no-classes-no-decorators)).
- Every service has a sibling `<domain>.service.test.ts`. It should run without
  booting the app.

See also: [/guide/routes-schemas](/guide/routes-schemas),
[/guide/context-di](/guide/context-di), [/guide/project-layout](/guide/project-layout).
