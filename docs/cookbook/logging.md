# Recipe: Correlating service-layer logs

**Problem:** every request gets a correlation id — `c.requestId` — but a
`<domain>.service.ts` function is a [pure function](/guide/services) with no
framework imports and no `c`. If a service wants to log something, how does that
log line end up tagged with the same `requestId` as the request's own log line,
without threading an extra `requestId` string through every service signature by
hand? ([#249](https://github.com/VicenzoMF/kata/issues/249))

**Pattern:** there is no new mechanism to learn here — this is the existing
["dependencies are arguments, not imports"](/guide/services#dependencies-are-arguments-not-imports)
rule, applied to the `logger` singleton. The route handler is the one place that
already holds both halves of the correlation — `c.get('logger')` and
`c.requestId` — so it builds a small **request-bound logger** (a plain object
that closes over the two) and passes *that* into the service as an ordinary
argument, exactly the way it passes `store` or `tx`. The service still imports
nothing from the framework; it just receives a logger-shaped value instead of a
bare `Logger`.

## 1. The id lives on `c`, not in the registry

`c.requestId` is a framework-owned field on the request/middleware context, not a
`scoped<T>()` slot ([ADR-0004](../adr/0004-di-via-scoped-slots.md); see the
`requestId` doc comment on `RouteContext` in
[`context.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/context.ts)).
That is deliberate — it is sealed, single-purpose request context like `c.raw`,
not a general DI value — but it also means a service, which never sees `c`, has
no way to read it on its own. The only path in is the same one every other
dependency takes: the route reads it and hands it down.

## 2. Bind the logger once, in the route

Write a small helper that wraps a `Logger` so every call it makes automatically
carries a fixed `requestId`. It lives at the `src/` root — open territory for
shared, non-HTTP infrastructure ([Project layout](/guide/project-layout#the-src-root)),
alongside things like `src/db.ts` or `src/store.ts`.

```ts
// src/logging.ts
import type { Logger, LogExtra } from '@katajs-framework/core'

/** The logger shape a service receives — identical to the framework's `Logger`. */
export type ServiceLogger = Logger

/**
 * Wrap a `logger` singleton so every call carries this request's correlation
 * id automatically. Build one per request in the route handler and pass it
 * into services as an ordinary argument (see the `checkout` example below).
 * `warn`/`error` fall back to `info` — the same degradation `logRequest` uses
 * internally — so a one-method logger still works.
 */
export function withRequestId(logger: Logger, requestId: string): ServiceLogger {
  const tag = (extra?: LogExtra): LogExtra => ({ ...extra, requestId })
  return {
    info: (message, extra) => logger.info(message, tag(extra)),
    warn: (message, extra) => (logger.warn ?? logger.info)(message, tag(extra)),
    error: (message, extra) => (logger.error ?? logger.info)(message, tag(extra)),
  }
}
```

`Logger` and `LogExtra` are exported from `@katajs-framework/core` for exactly this —
typing your own logger and small wrappers around it (see the [`@katajs-framework/core`
types](/reference/) table). Importing them here is fine: `src/logging.ts`
is root-level app code, not a `<domain>.service.ts` file, so it is not bound by
the "no framework imports" rule that applies inside `modules/`.

## 3. Pass the bound logger into the service like any other dependency

The service's signature grows one more plain parameter — no different in kind
from the `tx` or `userId` it already takes. Extending `shop`'s
[`checkout`](https://github.com/VicenzoMF/kata/blob/main/examples/shop/src/modules/orders/orders.service.ts):

```ts
// src/modules/orders/orders.service.ts
import type { ServiceLogger } from '../../logging'
import type { Store, Transaction } from '../../store'

import type { Order, OrderLine } from './orders.schema'

// ...CheckoutResult, CheckoutFailure, CheckoutErrorEnvelope unchanged...

export function checkout(tx: Transaction, userId: string, logger: ServiceLogger): CheckoutResult {
  const cartLines = tx.getCart(userId)
  if (cartLines.length === 0) {
    logger.warn('checkout rejected: empty cart', { userId })
    return { ok: false, error: 'cart_empty' }
  }

  // ...stage stock decrements, build orderLines, exactly as before...

  const order: Order = {
    id: crypto.randomUUID(),
    userId,
    lines: orderLines,
    totalCents: orderLines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0),
    status: 'paid',
    createdAt: new Date().toISOString(),
  }
  tx.putOrder(order)
  tx.setCart(userId, [])
  logger.info('checkout succeeded', { userId, orderId: order.id, totalCents: order.totalCents })
  return { ok: true, order }
}
```

`checkout` still imports nothing from the framework — `ServiceLogger` is a type
from `../../logging`, an app file, the same as `Store`/`Transaction` come from
`../../store`. The route builds the bound logger once, from pieces it already
has, and threads it through:

```ts
// src/modules/orders/orders.route.ts
import { withRequestId } from '../../logging'
// ...other imports unchanged...

export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx')
    const logger = withRequestId(c.get('logger'), c.requestId)
    const result = checkout(tx, c.get('currentUser').id, logger)
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
  },
})
```

Every log line `checkout` emits now carries the same `requestId` as the
framework's own per-request log line ([issue #63](https://github.com/VicenzoMF/kata/issues/63)) and the
`X-Request-Id` response header — one id, wherever the line came from.

## 4. Test it without a request

Because the service still just takes an argument, the test passes a fake
`ServiceLogger` and asserts on what it captured — no app, no `c`, no real
`requestId` in sight:

```ts
// src/modules/orders/orders.test.ts
import { describe, expect, it } from 'vitest'

import type { ServiceLogger } from '../../logging'
import { createStore } from '../../store'
import { addItem } from '../cart/cart.service'
import { checkout } from './orders.service'

function fakeLogger(): ServiceLogger & { calls: Array<{ level: string; message: string }> } {
  const calls: Array<{ level: string; message: string }> = []
  return {
    calls,
    info: (message) => calls.push({ level: 'info', message }),
    warn: (message) => calls.push({ level: 'warn', message }),
    error: (message) => calls.push({ level: 'error', message }),
  }
}

it('logs a warning when the cart is empty', () => {
  const logger = fakeLogger()
  checkout(createStore([]).begin(), 'u1', logger)
  expect(logger.calls).toEqual([{ level: 'warn', message: 'checkout rejected: empty cart' }])
})
```

## Why this doesn't reopen ADR-0004

ADR-0004 governs *how request-scoped state gets into `c.get(...)`* — the slot
mechanism, and the rule that nothing outside it smuggles per-request state into a
handler. This recipe never touches that mechanism: `withRequestId` builds an
ordinary value (a closure over a singleton and a string) in the route, and the
route passes it to the service the exact same way it passes `store`, `tx`, or
`c.get('currentUser').id` — a plain function argument, decided entirely by the
caller. No new scoped slot, no service reaching into the registry, nothing
request-scoped living anywhere but the route's local variables. A service given
a bound logger cannot tell it apart from any other `Logger`-shaped value you
constructed by hand in a test.

## Gotchas

- **Build the bound logger in the route, once per request** — not inside the
  service, and not by calling `withRequestId` more than once per request. Calling
  it in the service would mean importing `c.requestId` logic into a file that is
  supposed to know nothing about HTTP.
- **`ServiceLogger` is structural, not a marker type.** Any object with an
  `info`/`warn`/`error` matching the shape satisfies it — including the fake in
  step 4 — so tests never need the real framework `Logger` or a mocking library.
- **This is optional.** A service with no logging need takes no logger parameter
  at all; nothing about routes or middleware changes. Add the argument only to the
  services that actually log.
- **If a service is called from more than one route**, each call site builds and
  passes its own bound logger — there is no shared per-service instance to
  accidentally reuse a stale `requestId` from a previous request.
