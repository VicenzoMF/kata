---
title: Built-in middleware
description: Exact signatures, options, and defaults for kata's first-party middlewares — cors, secureHeaders, bodyLimit — and the request-id header constant.
---

# Built-in middleware

Three first-party middlewares ship from the `kata` core entry: `cors`,
`secureHeaders`, and `bodyLimit`. Each is a `Middleware<R>` factory you drop into
a route's `use:` chain or the app-level `middlewares` chain. Each declares
`provides: []` — it fills no scoped slot — and only sets response headers or
rejects a request; none touches the response body.

Request correlation (`x-request-id`) is **not** a middleware. It is built into the
runtime and applies to every response unconditionally. See
[Request id](#request-id) below.

For where these run, ordering against route `use:`, and the CORS-preflight
caveat, see [App-level middleware](/guide/app-middleware). This page is the
signature reference.

```ts
import { bodyLimit, cors, secureHeaders } from 'kata'
```

::: info All three are opt-in
None of these run unless you add them. A fresh `createApp` applies no CORS
policy, no security headers, and no body-size cap. The `init` template and the
`examples/hello` app add all three at the app level — copy that as your baseline.
:::

## `cors`

A thin wrapper over Hono's `cors`, shaped as a kata `Middleware<R>`.

```ts
function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R>
```

`CorsOptions` is `NonNullable<Parameters<typeof honoCors>[0]>` — it mirrors Hono's
CORS options exactly: `origin`, `allowMethods`, `allowHeaders`, `exposeHeaders`,
`maxAge`, and `credentials`. kata adds no options of its own and applies no
defaults beyond Hono's. See the
[Hono CORS docs](https://hono.dev/docs/middleware/builtin/cors) for the full
option semantics.

```ts
import { cors } from 'kata'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users],
  middlewares: [cors({ origin: 'https://app.example.com', credentials: true })],
})
```

Called with no argument, `cors()` passes `undefined` to Hono — Hono's own default
policy applies (`Access-Control-Allow-Origin: *`).

::: warning Preflight is not answered by a `use:` / global chain
kata registers a handler only for a route's declared method and has no implicit
`OPTIONS` route, so a browser preflight (`OPTIONS`) is never matched. `cors()`
still sets the `Access-Control-Allow-*` headers on the *actual* response, but it
does not answer the preflight. For full preflight handling, apply CORS as a native
Hono middleware on the app returned by `createApp` — `app.use('*', honoCors(...))`.
See [Handling CORS preflight](/guide/app-middleware#handling-cors-preflight).
:::

## `secureHeaders`

A thin wrapper over Hono's `secureHeaders`, shaped as a kata `Middleware<R>`.

```ts
function secureHeaders<R extends Registry = Registry>(
  options?: SecureHeadersOptions,
): Middleware<R>
```

`SecureHeadersOptions` is `NonNullable<Parameters<typeof honoSecureHeaders>[0]>` —
it mirrors Hono's secure-headers options: `xFrameOptions`,
`strictTransportSecurity`, `contentSecurityPolicy`, `referrerPolicy`, and the
rest. Pass `false` for an individual header to disable it. See the
[Hono secure-headers docs](https://hono.dev/docs/middleware/builtin/secure-headers).

With no options, `secureHeaders()` applies Hono's hardened baseline —
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Strict-Transport-Security`, and more — and removes `X-Powered-By`.

```ts
import { secureHeaders } from 'kata'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users],
  middlewares: [secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"] } })],
})
```

## `bodyLimit`

A thin wrapper over Hono's `bodyLimit`, shaped as a kata `Middleware<R>`. kata's
runtime reads the request body via `c.req.json()` with no size guard, so add
`bodyLimit` to reject oversized payloads before they are buffered and parsed. The
limit is enforced via the `Content-Length` header (fast path) and, when no
`Content-Length` is present, by measuring the streamed body.

```ts
function bodyLimit<R extends Registry = Registry>(
  options?: BodyLimitOptions,
): Middleware<R>
```

`BodyLimitOptions` is kata's own type — it does not pass through Hono's:

```ts
type BodyLimitOptions = {
  /** Maximum request body size in bytes. Defaults to DEFAULT_MAX_BODY_SIZE (1 MiB). */
  maxSize?: number
  /**
   * Response returned when the limit is exceeded. Defaults to HTTP 413 with the
   * unified kata error envelope.
   */
  onError?: (c: Context) => Response | Promise<Response>
}
```

### Defaults

`maxSize` defaults to `DEFAULT_MAX_BODY_SIZE`, exported from `kata`:

```ts
import { DEFAULT_MAX_BODY_SIZE } from 'kata'

DEFAULT_MAX_BODY_SIZE // 1024 * 1024 — 1 MiB
```

When the limit is exceeded and you supply no `onError`, the default returns HTTP
`413` with the unified kata error envelope
([ADR-0008](/adr/0008-unified-error-response-envelope)):

```json
{
  "error": "payload_too_large",
  "message": "Request body exceeds the maximum allowed size"
}
```

```ts
import { bodyLimit } from 'kata'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users],
  middlewares: [bodyLimit({ maxSize: 8 * 1024 })], // 8 KiB
})
```

Provide `onError` to customize the rejection. It receives the raw Hono `Context`
and must return a `Response`:

```ts
import { bodyLimit } from 'kata'

bodyLimit({
  maxSize: 8 * 1024,
  onError: (c) => c.json({ error: 'too_big' }, 413),
})
```

## Usage in `createApp`

The same factory works in a route's `use:` chain and in the app-level
`middlewares` chain. Because each declares `provides: []`, no route has to list
it. The `examples/hello` app applies all three at the app level:

```ts
import { bodyLimit, cors, secureHeaders } from 'kata'

import { createApp } from './context'
import * as users from './modules/users/users.route'
import * as echo from './modules/echo/echo.route'

const app = createApp({
  modules: [users, echo],
  // Runs before every route's own `use:`.
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

The global chain runs **before** each route's own `use:`. For the full ordering
table and the short-circuit / scoped-slot rules, see
[App-level middleware](/guide/app-middleware).

::: tip Per-route instead of global
A concern that belongs to one route stays in that route's `use:`:

```ts
defineRoute({
  method: 'POST',
  path: '/upload',
  use: [bodyLimit({ maxSize: 5 * 1024 * 1024 })], // 5 MiB, this route only
  input: { body: UploadBody },
  output: UploadResult,
  handler: (c) => /* ... */,
})
```
:::

## Why they need a wrapper

These three are ordinary Hono middlewares adapted to kata's response model. kata
builds its response at the *end* of a route's chain and returns it detached from
`c.res`, so a Hono middleware that sets headers *after* its own `next()` — like
`secureHeaders` — would otherwise be dropped. The internal adapter runs the Hono
middleware to completion first (with an inert `next`) so every header it sets is
on `c.res` before kata snapshots the response, then continues kata's chain. If the
wrapped middleware short-circuits with a `Response` (a `413`, a CORS preflight
`204`), that response is returned and the chain stops.

This makes the adapter correct for middleware that **only set response headers or
reject a request** — not for response-transformers (compression, ETag) that must
observe the final body. The adapter is internal: to wrap your own Hono middleware
you reach for [`defineMiddleware`](/reference/define-middleware) and write to the
scoped store with `c.set`. See [App-level middleware](/guide/app-middleware) for
the full explanation.

## Request id

kata assigns a correlation id to every request — there is no middleware to add and
no opt-out. The runtime reuses a well-formed inbound `x-request-id` header (so an
id minted at an edge proxy flows through unchanged) and otherwise generates a
fresh UUID. A malformed or oversized inbound value is ignored in favour of a
generated id. The resolved id is echoed on the `x-request-id` response header of
every outcome — including short-circuits and `5xx` errors — and is available as
`c.requestId` inside middleware and handlers.

Only the header name constant is exported:

```ts
import { REQUEST_ID_HEADER } from 'kata'

REQUEST_ID_HEADER // 'x-request-id'
```

::: info Validation of inbound ids
An inbound `x-request-id` is trusted only if it matches `^[\w.:-]{1,200}$` after
trimming — enough for UUIDs and W3C trace ids while keeping newlines and other
control characters (the header- and log-injection vector) out. Anything else is
replaced with a generated UUID.
:::

## Exports

Everything on this page comes from the `kata` core entry:

| Export | Kind | Notes |
| --- | --- | --- |
| `cors` | `Middleware<R>` factory | wraps Hono `cors` |
| `secureHeaders` | `Middleware<R>` factory | wraps Hono `secureHeaders` |
| `bodyLimit` | `Middleware<R>` factory | wraps Hono `bodyLimit` |
| `DEFAULT_MAX_BODY_SIZE` | `number` | `1024 * 1024` (1 MiB) |
| `CorsOptions` | type | mirrors Hono CORS options |
| `SecureHeadersOptions` | type | mirrors Hono secure-headers options |
| `BodyLimitOptions` | type | `{ maxSize?, onError? }` |
| `REQUEST_ID_HEADER` | `string` | `'x-request-id'` |

## See also

- [App-level middleware](/guide/app-middleware) — the `middlewares` chain,
  ordering, and the CORS-preflight pattern.
- [Middleware](/guide/middleware) — the `Middleware<R>` contract and scoped-slot
  filling for middleware you write.
- [`defineMiddleware`](/reference/define-middleware) — define your own middleware.
- [JWT auth](/reference/jwt) — the `kata/jwt` `jwtAuth` middleware.
