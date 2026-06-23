# ADR-0016: CORS preflight synthesis + middleware response-transform seam

- **Status:** Accepted
- **Date:** 2026-06-22
- **Deciders:** @VicenzoMF

## Context

Two gaps surfaced once the first-party hardening middlewares (`cors()`,
`secureHeaders()`, `bodyLimit()`) became app-wide via ADR-0012. Both stem from
how Kata wires Hono middleware, and both were left open by issue #157.

**(a) CORS preflight is not answered.** `registerRoute`
(`packages/kata/src/context.ts:566-584`) registers exactly `app[method](path, …)`
for a route's declared method and nothing else — there is no implicit `OPTIONS`
route. A browser preflight (`OPTIONS /items` with `Access-Control-Request-Method`)
therefore matches no handler and falls to Hono's 404 **before** any `cors()` in
the route's `use:` chain — or in the ADR-0012 global `middlewares` chain — ever
runs (`packages/kata/src/middlewares/cors.ts:28-30`). The consequence is subtle:
`cors()` today only decorates the **actual** response with
`Access-Control-Allow-*` headers; the preflight a real browser sends first is
never handled, so cross-origin non-simple requests fail despite `cors()` being
present. Preflight is a property of the **resource (path)**, not of a single
method, which is why no amount of method-level middleware fixes it.

**(b) Response-transforming Hono middleware cannot observe Kata's body.**
`fromHono` (`packages/kata/src/middlewares/from-hono.ts:26-37`) runs the wrapped
Hono middleware to completion with an **inert** `next` *before* the downstream
handler, so that headers it sets — even after its own `next` — land on `c.res`
before Kata snapshots the response. This is correct for header-setters
(`secureHeaders`) and request-rejecters (`bodyLimit`, a preflight 204), but it is
silently **wrong** for response-transformers (`compress()`, `etag()`) that wrap
`await next()` to mutate the *final body*: under `fromHono` they see no body at
all. Kata compounds the difficulty by building its response at the END of the
chain and returning it **detached from `c.res`** (the response object never
passes back through the Hono middleware's post-`next` code).

The forces in play:

- **ADR-0012 (app-level middleware).** The global `middlewares` chain runs inside
  `registerRoute`'s manual `runChain`, which only exists for a registered
  method+path. So `createApp({ middlewares: [cors()] })` fixes headers app-wide
  but does **not** answer preflight — the `OPTIONS` route still does not exist.
- **ADR-0004 (DI via scoped slots) / the auth pipeline.** A preflight request
  carries no credentials by spec, so it must **not** be subjected to a JWT guard
  or any other chain entry that could 401/short-circuit it. Whatever answers
  preflight must run a narrow, auth-free path.
- **The unified response pipeline.** Every outcome (success, 422, short-circuit,
  5xx) funnels through `finalizeResponse` for the `x-request-id` echo and the
  per-request log line (ADR-0012 context). A new response path should not become
  an observability blind spot.

Issue #157 asked us to decide, for each gap, between a framework-handled path and
a documented BYO-at-the-edge boundary. We choose the framework-handled path for
both: Kata's thesis is that cross-cutting HTTP correctness is the framework's
job, not a footgun left to each route author.

## Decision

We will (a) **auto-synthesize an `OPTIONS` preflight responder** for any path
whose effective chain contains a CORS middleware, and (b) add an **opt-in
`fromHonoTransform()`** adapter that wires a real `next` so response-transformers
observe Kata's final body.

### (a) Synthetic OPTIONS preflight

**1. Brand the CORS middleware.** `cors()` gains a structural marker so the
runtime can recognize it in an otherwise opaque `Middleware<R>` chain. The marker
carries the `CorsOptions` it was built with:

```ts
// middlewares/cors.ts — additive
export function cors<R>(options?: CorsOptions): Middleware<R> {
  return {
    __kata: 'middleware',
    provides: [],
    handler: fromHono<R>(honoCors(options)),
    __preflight: options ?? {}, // NEW — marks this entry as a CORS source
  }
}
```

`Middleware<R>` gains one optional field, `readonly __preflight?: CorsOptions`.
It is inert for every middleware except `cors()`.

**2. Collect preflight paths once, at build time.** In `buildHonoApp`
(`packages/kata/src/context.ts:259-276`), while iterating modules, compute each
route's effective chain (`[...config.middlewares, ...route.use]`). If any entry
carries `__preflight`, record `path → { options, methods }`, **deduplicated by
path** (multiple methods on one path yield a single preflight responder), and
**aggregating the declared methods** of that path into `Access-Control-Allow-Methods`.

**3. Register one synthetic `OPTIONS <path>` per recorded path.** The handler
runs **only the CORS middleware** — not the route's full chain — so a preflight
is never subjected to auth or any other short-circuiting entry. The CORS
middleware already short-circuits an `OPTIONS` request with a `204` + the
`Access-Control-Allow-*` headers (this is the `short instanceof Response` branch
in `from-hono.ts:33`); that `Response` is returned through `finalizeResponse`, so
the preflight still gets the `x-request-id` echo and the per-request log line.

**4. Yield to explicit declarations.** If a module already declares an explicit
`OPTIONS <path>` route, the synthetic responder is **not** registered for that
path — the author's route wins.

Net effect: declaring `cors()` (per-route or as an ADR-0012 global) makes
preflight Just Work, with no new public API and no `OPTIONS` route the author
must hand-write.

### (b) `fromHonoTransform()` — response-transform seam

We add a second, **opt-in** adapter alongside `fromHono`, for the narrow class of
Hono middleware that must transform the final response body:

```ts
// middlewares/from-hono.ts — new export
import { compress } from 'hono/compress'
defineRoute({ method: 'GET', path: '/report', use: [fromHonoTransform(compress())], … })
```

Unlike `fromHono` (inert `next`, runs before the handler), `fromHonoTransform`
wires a **real** `next`: it lets Kata's downstream chain build the final
`Response`, places that `Response` on `c.res` so the wrapped middleware's
post-`next` code can read and replace it, then threads the (possibly transformed)
`c.res` back as Kata's response. Because a transformer must wrap *everything*
downstream, a `fromHonoTransform` entry is required to be the **outermost** entry
of its effective chain (declared first); ordering is enforced by a companion
rule (below) rather than silently mis-wired.

`fromHono` is unchanged and remains the default for header-setters and
request-rejecters. `fromHonoTransform` is never used implicitly — the author opts
in per middleware.

## Alternatives considered

### (a) Alternative A — Bless `app.use('*', honoCors())` as the only supported path
Document that full preflight is done with native Hono CORS on the instance
`createApp` returns, leaving `cors()`-in-a-chain as header-only. Rejected: it
turns `cors()` into a half-feature whose name implies preflight handling it does
not deliver — a documented footgun. It also splits CORS config across two
surfaces (the kata `cors()` for headers, a raw Hono `app.use` for preflight) and
leans on the `KataApp<Mods>` cast (`context.ts:224`) exposing `.use` ergonomically.
The framework should own a correctness concern this load-bearing.

### (a) Alternative B — `createApp({ enableCors })` app option
A declarative option wiring both headers and the preflight route. Rejected: it
introduces a new framework surface that re-exposes a subset of Hono's CORS
options and duplicates what `cors()` + ADR-0012 globals already express. The
synthetic-OPTIONS approach reuses the existing `cors()` value and its options
verbatim, with zero new public configuration.

### (b) Alternative — Keep the boundary, add only a guardrail/doc
Leave `fromHono` header-only and document that `compress()`/`etag()` belong on the
returned Hono instance (`app.use('*', compress())`), flagging misuse with a lint
rule. Rejected as the **sole** answer: it permanently bars co-locating a
transform with the route that needs it and asks authors to reason about two
disjoint middleware worlds. We still ship the guardrail (see Companion rules) —
but as a redirect *to* `fromHonoTransform`, not as a dead end.

## Consequences

### Positive
- `cors()` (or an ADR-0012 global) now answers real browser preflight with no
  extra code and no hand-written `OPTIONS` route.
- Preflight responses flow through `finalizeResponse`: they carry `x-request-id`
  and appear in request logs like any other response.
- Preflight runs an auth-free, single-middleware path — a JWT guard on the route
  never 401s the credential-less preflight.
- `fromHonoTransform` makes `compress()`/`etag()` correct *inside* a route's
  chain, co-located with the route, instead of only at the app edge.
- No breaking change: `fromHono` semantics are untouched; `cors()` gains an inert
  field; `fromHonoTransform` is a new opt-in export.

### Negative / costs
- `cors()` now triggers **implicit route registration** (a synthetic `OPTIONS`).
  This is new "magic"; it is bounded (one route per CORS-bearing path, yields to
  explicit `OPTIONS`) and documented here, but it is a departure from "what you
  declare is what is registered".
- `Middleware<R>` gains a CORS-specific `__preflight` field — a small leak of one
  middleware's concern into the shared type.
- `Access-Control-Allow-Methods` aggregation is per declared path; a path served
  across multiple modules must be aggregated correctly or the header under-reports
  allowed methods.
- `fromHonoTransform` introduces a **second** adapter semantics (wrap-`next` vs
  `fromHono`'s pre-`next`). Authors must pick the right one; the ordering
  constraint (outermost) is a new rule to learn and enforce.
- Threading `c.res` back through Kata's otherwise-detached response model is the
  delicate part of (b)'s implementation and must be covered by tests for body,
  headers, and status preservation.

### Follow-ups
- Implement (a): the `__preflight` marker, the build-time path collection +
  method aggregation, and synthetic `OPTIONS` registration in `buildHonoApp`,
  with unit + Hurl coverage (preflight 204, headers, auth-free path, explicit
  `OPTIONS` wins, non-CORS path still 404s).
- Implement (b): `fromHonoTransform` and tests asserting `compress()`/`etag()`
  observe and replace the final body, and that status/headers survive.
- Companion `kata verify` rules below.
- Migrate docs/examples: show `cors()` answering preflight, and `compress()` via
  `fromHonoTransform`.

## Companion rules

Mechanical enforcement of this ADR will live in `0016.rules.ts` (archgate
pattern), implemented with the `kata verify` rule engine. Rule IDs introduced:

- `kata/transform-via-from-hono` — a known response-transformer (`compress`,
  `etag`, …) wrapped in `fromHono(...)` is silently a no-op; it must use
  `fromHonoTransform(...)`.
- `kata/transform-must-be-outermost` — a `fromHonoTransform(...)` entry must be
  the first entry of a route's effective chain, so it wraps all downstream
  middleware and the handler.
