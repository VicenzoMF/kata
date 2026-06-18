---
title: App-level middleware
description: The createApp middlewares chain runs before every route. Declare cross-cutting concerns — cors, secureHeaders, bodyLimit — once instead of per route.
---

# App-level middleware

A route declares its own middleware in `use:`, and that is the right place for a
concern that belongs to one route. But cross-cutting concerns — CORS, secure response
headers, a body-size cap — belong to *every* route. Copying them onto each
`defineRoute` is a DRY violation, and a route you forget to update is a route without
them.

`createApp` takes an optional `middlewares` chain for exactly this. It runs **before**
every route's own `use:`.

```ts
import { bodyLimit, cors, secureHeaders } from 'kata'

import { createApp } from './context'
import * as users from './modules/users/users.route'
import * as echo from './modules/echo/echo.route'

const app = createApp({
  modules: [users, echo],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

There is nothing new to learn to use it: the chain shares the exact `Middleware<R>`
contract route middleware uses — same runtime pipeline, same per-request scoped store —
so any middleware that works in a route's `use:` works here unchanged. See
[ADR-0012](/adr/0012-app-level-middleware) for the decision.

## Ordering

The effective chain for any route is the global chain followed by the route's own, each
in declared (array) order:

```
effective = [...config.middlewares, ...route.use]
```

| Phase | What runs |
| --- | --- |
| 1. Global chain | `config.middlewares`, in order — outermost |
| 2. Route chain | `route.use`, in order |
| 3. Input validation | `422` envelope on failure |
| 4. Handler | `route.handler` |
| 5. Output validation | strict/log per [ADR-0009](/adr/0009-output-validation-mode) |

This is the same onion model from [Middleware](/guide/middleware), one layer further
out: a global middleware wraps the *entire* route pipeline — its on-the-way-in code runs
before any route middleware, and its on-the-way-out code runs after the handler has
returned.

Two properties carry over from route middleware verbatim, because a global is just an
earlier element of the same array:

- **Short-circuit.** A global may `return` a `Response` to stop the request. It skips
  every later global, the whole `use:` chain, and the handler. The returned response
  still gets the `x-request-id` header and is logged like any other outcome.
- **Scoped slots.** A scoped slot a global middleware `provides:` is readable via
  `c.get` in *every* handler — the global runs before the handler and writes the same
  per-request store the handler reads. A global `authMiddleware` with
  `provides: ['currentUser']` makes `c.get('currentUser')` valid in every route without
  that route listing it in `use:`.

::: warning A global runs for every route
There is no per-route opt-out. A middleware in the global chain runs for every route,
including ones that do not need it. Choosing and ordering the chain is your
responsibility. If a concern is genuinely route-specific, keep it in that route's
`use:`.
:::

## Built-ins

Three first-party hardening middlewares ship from the `kata` core entry. Each is a
`Middleware<R>` factory, declares `provides: []`, and sets response headers (or rejects
a request) without touching the response body.

### `cors`

```ts
function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R>
```

A thin wrapper over Hono's `cors`. `CorsOptions` mirrors Hono's options — `origin`,
`allowMethods`, `allowHeaders`, `exposeHeaders`, `maxAge`, `credentials` — see the
[Hono CORS docs](https://hono.dev/docs/middleware/builtin/cors).

```ts
import { cors } from 'kata'

createApp({
  modules: [users],
  middlewares: [cors({ origin: 'https://app.example.com', credentials: true })],
})
```

::: warning Preflight is not handled by the global chain
Kata registers a handler only for a route's declared method and has no implicit
`OPTIONS` route, so a browser preflight (`OPTIONS`) is never matched. `cors()` in the
global chain still sets the `Access-Control-Allow-*` headers on the actual response, but
it does not answer the preflight. For full preflight handling, see
[Handling CORS preflight](#handling-cors-preflight) below.
:::

### `secureHeaders`

```ts
function secureHeaders<R extends Registry = Registry>(
  options?: SecureHeadersOptions,
): Middleware<R>
```

A thin wrapper over Hono's `secureHeaders`. With no options it applies Hono's hardened
baseline — `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Strict-Transport-Security`, and more — and removes `X-Powered-By`. `SecureHeadersOptions`
mirrors Hono's options (`xFrameOptions`, `strictTransportSecurity`,
`contentSecurityPolicy`, `referrerPolicy`, …); pass `false` for an individual header to
disable it. See the
[Hono secure-headers docs](https://hono.dev/docs/middleware/builtin/secure-headers).

```ts
import { secureHeaders } from 'kata'

createApp({
  modules: [users],
  middlewares: [secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"] } })],
})
```

### `bodyLimit`

```ts
function bodyLimit<R extends Registry = Registry>(
  options?: BodyLimitOptions,
): Middleware<R>
```

Kata's runtime reads the request body via `c.req.json()` with no size guard. Add
`bodyLimit` to reject oversized payloads before they are buffered and parsed. The limit
is enforced via the `Content-Length` header (fast path) and, when absent, by measuring
the streamed body.

```ts
type BodyLimitOptions = {
  maxSize?: number // bytes; defaults to DEFAULT_MAX_BODY_SIZE (1 MiB)
  onError?: (c: Context) => Response | Promise<Response>
}
```

`maxSize` defaults to `DEFAULT_MAX_BODY_SIZE` — `1024 * 1024` (1 MiB), exported from
`kata`. When the limit is exceeded the default `onError` returns HTTP `413` with the
unified kata error envelope ([ADR-0008](/adr/0008-unified-error-response-envelope)):

```json
{ "error": "payload_too_large", "message": "Request body exceeds the maximum allowed size" }
```

```ts
import { bodyLimit } from 'kata'

createApp({
  modules: [users],
  middlewares: [bodyLimit({ maxSize: 8 * 1024 })], // 8 KiB
})
```

## Adapting a Hono middleware

The three built-ins are not special: each is an ordinary Hono middleware wrapped to fit
Kata's `Middleware<R>` contract. Understanding *why* the wrapper is needed explains a
real constraint on what can go in a chain.

Here is the problem. Kata builds its response at the *end* of a route's chain and
returns it detached from `c.res`. A normal Hono middleware that sets response headers
*after* its own `next()` — `secureHeaders` is one — expects to write those headers onto
`c.res` on the way back out. But by then Kata has already snapshotted the response, so
those headers would simply be dropped.

The wrapper sidesteps that by changing *when* the Hono middleware runs. It executes the
wrapped middleware to completion first, handing it an inert `next`, so every header it
sets lands on `c.res` *before* Kata builds the response — then it continues Kata's own
chain. And if the wrapped middleware short-circuits with a `Response` (a `413`, a CORS
preflight `204`), that response is returned and the chain stops.

The catch: this is correct only for middleware that **set response headers or reject a
request**. A response *transformer* — compression, ETag — needs to observe the final
body, which it never gets here, so it does not belong in a `use:` or global chain at
all. (This is the same constraint route middleware lives under; see the `c.header`
warning in [Middleware](/guide/middleware).)

For middleware you write yourself — populating a scoped slot from a session cookie or
API key, layering authorization — do not wrap a Hono middleware. Use `defineMiddleware`
and write to the scoped store with `c.set` directly. See [Middleware](/guide/middleware)
for the slot-filling pattern and [JWT auth](/guide/jwt) for the auth-specific path.

## Handling CORS preflight

`cors()` in the global chain sets CORS headers on real responses but does not answer the
`OPTIONS` preflight, because Kata has no implicit `OPTIONS` route. `createApp` returns a
parametric Hono app, so register a native Hono middleware on it for the preflight:

```ts
import { cors as honoCors } from 'hono/cors'

const app = createApp({
  modules: [users],
  middlewares: [cors(), secureHeaders()],
})

// Native Hono middleware on the returned app — answers OPTIONS preflight.
app.use('*', honoCors({ origin: 'https://app.example.com', credentials: true }))

export type AppType = typeof app
```

::: tip
`app.use('*', …)` here is a plain Hono call, not part of Kata's `middlewares` chain — it
does not see the scoped store and does not flow through Kata's response funnel. Use it
only for the preflight; keep your request-time concerns in the Kata `middlewares` chain.
:::

## See also

- [Middleware](/guide/middleware) — the `Middleware<R>` contract, `provides:`, and
  scoped-slot filling.
- [Reference: middleware](/reference/middleware) — exact signatures for the built-ins
  and their option types.
- [ADR-0012](/adr/0012-app-level-middleware) — why the global chain extends the manual
  route chain instead of `app.use`.
