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
import { bodyLimit, cors, secureHeaders } from '@katajs-framework/core'

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

`kata verify` reads this chain the same way the runtime runs it. Its
`kata/scoped-slot-not-provided` rule walks `[...config.middlewares, ...route.use]`
in order per route, so a global provider satisfies every route's reads, and a
global middleware that itself reads a slot nothing ahead of it provides is an
error. The built-ins below resolve through the `provides.json` manifest `@katajs-framework/core`
ships — `cors()` in a chain is a `provides: []` entry, not an unknown — so
declaring them costs no verification coverage. An entry the rule *cannot* read is
reported as a [suppression](/guide/harness#when-a-rule-cannot-prove-a-check)
rather than passing silently.

::: warning A global runs for every route
There is no per-route opt-out. A middleware in the global chain runs for every route,
including ones that do not need it. Choosing and ordering the chain is your
responsibility. If a concern is genuinely route-specific, keep it in that route's
`use:`.
:::

## Built-ins

Three first-party hardening middlewares ship from the `@katajs-framework/core` core entry. Each is a
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
import { cors } from '@katajs-framework/core'

createApp({
  modules: [users],
  middlewares: [cors({ origin: 'https://app.example.com', credentials: true })],
})
```

::: tip Preflight is answered automatically
`cors()` does the whole job wherever you declare it — per route or in the global
chain: besides setting the `Access-Control-Allow-*` headers on actual responses, the
runtime auto-registers a synthetic `OPTIONS` responder for its path, per
[ADR-0020](/adr/0020-cors-preflight-and-response-transform-seam). Do not register CORS
a second time. See [CORS preflight](#cors-preflight) below for how it works.
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
import { secureHeaders } from '@katajs-framework/core'

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
`@katajs-framework/core`. When the limit is exceeded the default `onError` returns HTTP `413` with the
unified kata error envelope ([ADR-0008](/adr/0008-unified-error-response-envelope)):

```json
{ "error": "payload_too_large", "message": "Request body exceeds the maximum allowed size" }
```

```ts
import { bodyLimit } from '@katajs-framework/core'

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

The catch: this adapter — `fromHono`, used internally by all three built-ins — is
correct only for middleware that **set response headers or reject a request**. A
response *transformer* — compression, ETag — needs to observe the *final* body, which
it never gets from an inert `next()` run before Kata's own chain. (This is the same
constraint route middleware lives under; see the `c.header` warning in
[Middleware](/guide/middleware).)

### `fromHonoTransform`

For that narrower case — a response-transforming Hono middleware — a second, opt-in
adapter exists
([ADR-0020](/adr/0020-cors-preflight-and-response-transform-seam)):

```ts
import { fromHonoTransform } from '@katajs-framework/core'
import { compress } from 'hono/compress'

defineRoute({
  method: 'GET',
  path: '/report',
  use: [fromHonoTransform(compress())],
  // ...
})
```

Unlike `fromHono`, it wires a *real* `next`: calling it lets Kata's own chain and
handler run to completion first, places the resulting `Response` where the wrapped
middleware reads it, and — when the middleware replaces it, the way `compress()` and
`etag()` both do — sends that replacement back as Kata's response instead. The
tradeoff is one constraint: to see the final body, the entry has to wrap *everything*
downstream, so it must be the first entry of its effective chain — an earlier global,
or another `use:` entry ahead of it, and kata throws at startup rather than silently
dropping the transform. `fromHono` stays the default for everything else — header-setters
and request-rejecters.

For middleware you write yourself — populating a scoped slot from a session cookie or
API key, layering authorization — do not wrap a Hono middleware with either adapter.
Use `defineMiddleware` and write to the scoped store with `c.set` directly. See
[Middleware](/guide/middleware) for the slot-filling pattern and
[JWT auth](/guide/jwt) for the auth-specific path.

## CORS preflight

Before any non-simple cross-origin request, a browser sends a preflight — `OPTIONS` on
the same path, with `Access-Control-Request-Method`. Kata registers a handler only for a
route's *declared* method and has no implicit `OPTIONS` route, so a preflight would
otherwise never match — and preflight is a property of the *path*, not of any one
method's chain, so no per-route middleware alone could answer it. The runtime closes
that gap itself ([ADR-0020](/adr/0020-cors-preflight-and-response-transform-seam)):
while building the app, it walks every route's effective chain — the global
`middlewares` plus that route's own `use:` — and for every path whose chain carries a
`cors()` anywhere in it, auto-registers a real `OPTIONS <path>` route that runs *just*
that `cors()`.

Declaring `cors()` is therefore the complete CORS story, whether it is global or
per-route:

```ts
const app = createApp({
  modules: [users],
  middlewares: [cors({ origin: 'https://app.example.com', credentials: true })],
})
// OPTIONS /users → 204 + Access-Control-Allow-* — nothing else to register.
```

```ts
defineRoute({
  method: 'POST',
  path: '/items',
  use: [cors()],
  // ...
})
// OPTIONS /items → 204 too, even though cors() is declared on this one route only.
```

If more than one route shares a path — `GET /items` and `POST /items`, both carrying
`cors()` — kata registers a single `OPTIONS /items` responder and reports both methods
in `Access-Control-Allow-Methods`, unless you already pinned `allowMethods` yourself in
the `CorsOptions`.

Three properties follow from *how* the preflight is answered:

- **Auth-free.** The synthetic responder runs *only* the `cors()` that triggered it —
  never the route's own `use:` chain, never any other global. A JWT guard on the
  protected route never sees, and so never 401s, the credential-less preflight.
- **Observable.** The `204` funnels through the same response pipeline as every other
  outcome: it echoes `x-request-id` and produces the per-request log line.
- **Opt-in.** A path with no `cors()` anywhere in its effective chain gets no synthetic
  `OPTIONS` route; a preflight against it falls through to the normal unmatched-request
  decision — `405` with an `Allow` header on a declared path, `404` otherwise.

Do **not** also register Hono's `cors` natively on the returned app
(`app.use('*', honoCors(...))`) — an earlier version of this guide showed that as a
workaround, but today it registers CORS twice and splits your edge policy across two
places for zero gain: the preflight response is identical without it.

## See also

- [Middleware](/guide/middleware) — the `Middleware<R>` contract, `provides:`, and
  scoped-slot filling.
- [Reference: middleware](/reference/middleware) — exact signatures for the built-ins
  and their option types.
- [ADR-0012](/adr/0012-app-level-middleware) — why the global chain extends the manual
  route chain instead of `app.use`.
- [ADR-0020](/adr/0020-cors-preflight-and-response-transform-seam) — why the framework
  answers CORS preflight itself and how the `fromHonoTransform` seam works.
