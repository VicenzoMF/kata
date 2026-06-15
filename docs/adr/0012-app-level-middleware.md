# ADR-0012: App-level (global) middleware

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** @VicenzoMF

## Context

`createApp({ modules })` has no slot for cross-cutting middleware. The first-party
hardening middlewares — `cors()`, `secureHeaders()`, `bodyLimit()`
(`packages/kata/src/middlewares/`) — are `Middleware<R>` values that must be added
to **every** route's `use:` chain individually. A real app applies them
app-wide, so today they are either copy-pasted onto each `defineRoute` or quietly
forgotten on a freshly added route. The epic (#84) is to declare such concerns
once.

The shape is constrained by decisions already in place:

- **ADR-0004 (DI via scoped slots).** A middleware may `provides:` scoped slots; a
  handler's `c.get('slot')` is only sound if a middleware that `c.set`s it ran
  first. The `kata/scoped-slot-not-provided` lint rule
  (`packages/verify/src/rules/scoped-slot-not-provided.ts`) proves this statically
  by unioning the `provides` of a route's `use:` chain. A global chain changes
  what "ran first" means for **every** route, so that rule has to be reconciled.
- **The runtime response model.** `registerRoute` (`packages/kata/src/context.ts`)
  runs a route's `use:` chain by hand (`runChain`), captures a middleware's
  short-circuit when its handler returns a `Response`, and funnels **every**
  outcome — success, 422, short-circuit, 5xx — through `finalizeResponse`, which
  echoes the `x-request-id` header and emits the per-request log line. Kata builds
  its response at the end of the chain and returns it **detached from `c.res`**
  (see `middlewares/from-hono.ts`), which is why short-circuit is "return a
  `Response`", not "set `c.res`".

Four questions to settle before anyone writes the runtime (#86), migrates the docs
and examples (#87), or teaches the linter (#88):

1. **Shape & ordering** — where the chain is declared and where it runs relative
   to per-route `use:`.
2. **Short-circuit** — may a global middleware return a `Response` to stop the
   request?
3. **Scoped-slot provision** — does a slot a global middleware `provides:` satisfy
   `c.get` in *every* handler, and how does that reconcile with
   `kata/scoped-slot-not-provided`?
4. **Mechanism** — a true Hono `app.use('*', …)`, or extend the existing manual
   chain in `registerRoute`.

## Decision

We will add an optional `middlewares` chain to `createApp` that runs **before**
every route's `use:` chain, sharing the exact `Middleware<R>` contract, runtime
pipeline, and per-request scoped store that route middleware already uses.

```ts
createApp({
  modules: [users, echo, diag],
  middlewares: [secureHeaders(), cors(), bodyLimit()], // run before every route's use:
})
```

`AppConfig<R, Mods>` gains one field:

```ts
export type AppConfig<R, Mods> = {
  modules: Mods
  middlewares?: readonly Middleware<R>[] // NEW — app-level chain, runs first
  requestLogging?: boolean
  outputValidation?: OutputValidationMode
}
```

### Ordering

The effective chain for any route is the global chain followed by the route's own,
each in declared (array) order:

```
effective = [...config.middlewares, ...route.use]
```

| Phase | What runs |
|---|---|
| 1. Global chain | `config.middlewares`, in order — outermost |
| 2. Route chain | `route.use`, in order |
| 3. Input validation | `readInputs` → 422 envelope on failure |
| 4. Handler | `route.handler` |
| 5. Output validation | `buildResponse` (ADR-0009 mode, ADR-0011 status map) |
| (every outcome) | `finalizeResponse` — `x-request-id` echo + request log |

Global-first is the standard onion: a global middleware wraps the entire route
pipeline, so its pre-`next()` code runs before any route middleware and its
post-`next()` code runs after the handler. "Declared order is the contract" is
already how `use:` composes dependent slots (ADR-0004 follow-up); the global chain
extends the same array semantics leftward.

### Short-circuit — yes, identical contract

A global middleware may return a `Response` to short-circuit, exactly as a route
middleware does (`Middleware<R>['handler']` already returns
`Promise<void | Response> | void | Response`). A global short-circuit skips every
later global, the whole `use:` chain, and the handler. The returned `Response`
still flows through `finalizeResponse`, so it gets the `x-request-id` header and is
logged like any other outcome. This needs **no** new code: `runChain` already does
`if (result instanceof Response) shortCircuit = result`, and globals are merely
earlier entries in the same array.

### Scoped-slot provision — a global `provides` satisfies all routes

A slot a global middleware `provides:` is readable via `c.get` in **every**
handler. This is sound at runtime by construction:

- `getScopedStore(c)` is one `Map` per request, keyed on the Hono context `c`, and
  is shared by every `makeMiddlewareContext` / `makeRouteContext` built during that
  request. A global middleware's `c.set('user', …)` writes that Map; the handler's
  `c.get('user')` reads it back.
- The global chain runs **before** the route chain and handler (ordering above), so
  a globally-provided slot is always populated before any read.

So a global `authMiddleware` with `provides: ['user']` makes `c.get('user')` valid
in every route without that route listing it in `use:`.

**Reconciling `kata/scoped-slot-not-provided` (ADR-0004 → issue #88).** The rule
today unions only the `provides` of a route's `use:` chain (`resolveUse`); a route
reading a globally-provided slot, with an empty or unrelated `use:`, would be
**falsely flagged**. #88 extends the rule: locate the `createApp({ middlewares: […] })`
call, resolve each entry against the same `defineMiddleware → provides` map the rule
already builds (`buildProvidesMap`), and add that union to **every** route's
`provided` set before checking reads. The rule's existing conservatism carries over
verbatim — a global entry that is a factory call (`cors()`), a spread, or an
identifier whose `provides` is itself indeterminate makes the global contribution
**indeterminate**, suppressing the affected reads exactly as an unresolved `use:`
entry does today, so the false-positive rate stays at zero. The sibling rule
`kata/middleware-provides-mismatch` is unaffected: it checks a middleware
definition in isolation, regardless of where the middleware is used.

Note the migration order this implies: only slot-**providing** globals depend on
#88. The shipping hardening middlewares declare `provides: []`, so #87 can move
`cors`/`secureHeaders`/`bodyLimit` to the global slot without waiting on the lint
change.

### Mechanism — extend the manual chain, not `app.use`

The global chain is **prepended to each route's chain inside `registerRoute`** —
not registered as a native Hono `app.use('*', …)`. The combined chain is built once
at registration (not per request):

```ts
// in registerRoute (or buildHonoApp threading config.middlewares through):
const chain = globals.length > 0 ? [...globals, ...route.use] : route.use
// runChain iterates `chain` instead of `route.use`; nothing else changes.
```

Everything that makes route middleware work then applies to global middleware *for
free*, because a global is just an earlier element of the same array:

- the same `MiddlewareContext` from `makeMiddlewareContext` (`c.get/set/json/error`,
  the shared scoped store, and the one `requestId` resolved per request and threaded
  to every frame);
- the same `result instanceof Response` short-circuit capture;
- the same `finalizeResponse` funnel (request-id echo + logging) over the result;
- the same `try/catch` route-pipeline boundary that converts a throw into the
  unified 5xx envelope (ADR-0008).

Because Hono dispatches one request to exactly one route handler, prepending to each
route's chain runs each global **once per request** — there is no per-route
multiplication at request time; the only per-route work is the one-time array concat
at registration.

## Alternatives considered

### Alternative A — true Hono `app.use('*', handler)`
Register each global as a native Hono middleware. Rejected: it splits the request
lifecycle. Kata middleware speaks a `MiddlewareContext` and signals short-circuit by
**returning** a `Response`; Hono middleware gets a raw `Context` and short-circuits
via `c.res`/not calling `next()` — the very impedance mismatch `fromHono` exists to
bridge, and only for header-setting/rejecting middleware. A global short-circuit
through Hono's pipeline would bypass `finalizeResponse`, losing the `x-request-id`
header and the request log unless that funnel were duplicated; `requestId` (resolved
inside the route handler today) would have to be hoisted into a separate global
handler; and kata's own return-a-`Response` middlewares would each need
`fromHono`-style wrapping to participate. More moving parts for no gain.

### Alternative B — one global pre-chain via a single `app.use('*')`
Run the kata global chain once per request inside a single native `app.use('*')`
that populates the shared per-request scoped store, leaving `registerRoute` to run
only `route.use`. The superficial appeal — "run globals once per request, not per
route" — is empty: one request matches one route, so the manual-chain approach
already runs each global exactly once per request. What remains is pure cost: the
short-circuit, request-id, logging, and 5xx-boundary funnel still live in
`registerRoute`, so this bifurcates the lifecycle across two places for no benefit.
Rejected — it is Alternative A with a thinner disguise.

### Alternative C — status quo: repeat the middlewares per route
Keep adding `cors()/secureHeaders()/bodyLimit()` to every route's `use:`. Rejected:
this is exactly the per-route repetition the epic removes — DRY violation,
easy to forget on a new route, and noise on every `defineRoute`. The cross-cutting
hardening middlewares are the canonical case for declare-once.

### Alternative D — path-scoped global groups (`{ '/admin/*': [...] }`)
Let `middlewares` be a map from path prefix to chain so a global applies to a
subtree. Deferred, not rejected on merit: v0.3 wants the smallest useful surface — a
single flat chain that runs for all routes. Per-prefix grouping is an additive
follow-up ADR if real usage needs it; a flat chain plus per-route `use:` already
covers "global everywhere" and "this route only".

## Consequences

### Positive
- Cross-cutting concerns are declared once. `cors`/`secureHeaders`/`bodyLimit` move
  to `createApp({ middlewares })` and stop being copy-pasted per route (#87).
- **Zero new runtime machinery.** Reusing `runChain`, `makeMiddlewareContext`, the
  shared scoped store, `finalizeResponse`, and the 5xx boundary means short-circuit,
  request-id echo, logging, and error funnelling cover global middleware with no new
  code paths to test in isolation.
- One mental model and one type: global and route middleware are both
  `Middleware<R>`, so any existing middleware — including `fromHono`-wrapped ones —
  drops into the global slot unchanged.
- Global providers populate the same per-request store the handler reads, so
  "global `provides` ⇒ readable everywhere" is sound without new plumbing.

### Negative / costs
- It weakens ADR-0004's *explicit per-route dependency trace*: a handler can read a
  scoped slot whose provider is declared globally and is therefore invisible at the
  route. Mitigation: the lint rule still mechanically proves the slot is provided by
  something that definitely runs first; teams who want the dependency visible in the
  route keep the provider in `use:` instead of the global chain.
- The `kata/scoped-slot-not-provided` rule **must** learn about global providers
  (#88) or it false-positives on every route reading a globally-provided slot. Until
  #88 lands, only slot-*providing* globals are affected; the `provides: []` hardening
  middlewares are not, so #87 is unblocked.
- A global runs for **every** route, including routes that do not need it; there is
  no per-route opt-out in v0.3 (path-scoped globals are the deferred Alternative D).
  Choosing and ordering the global chain is the app author's responsibility.
- Global middleware inherits the route-middleware constraint that kata's response is
  detached from `c.res`: it may set response headers and short-circuit, but cannot
  post-process the final body. Response transformers (compression, ETag) still do not
  belong in a `use`/global chain — same caveat `from-hono.ts` documents.

### Follow-ups
- **#86 (runtime)** — add `AppConfig.middlewares`, thread it into `registerRoute`
  (e.g. on `RuntimeOptions`, resolved once in `resolveRuntimeOptions`), prepend to
  each route's chain, and unit-test ordering, short-circuit, and a global-provided
  slot read end-to-end.
- **#88 (verify)** — extend `kata/scoped-slot-not-provided` to union app-level
  providers from the `createApp({ middlewares })` call into every route, with the
  same indeterminate bail-out; tests for "globally-provided read is not flagged" and
  "read provided by neither global nor `use:` is still flagged".
- **#87 (docs/examples)** — migrate `cors`/`secureHeaders`/`bodyLimit` to the global
  slot in the cookbook and at least one example; update the README hardening note.
- **Future** — path-scoped global groups (Alternative D) if usage calls for it.

## Companion rules

This ADR introduces **no new rule ID**. It *amends* an existing rule: issue #88
extends `kata/scoped-slot-not-provided` (owned by ADR-0004) so that a scoped slot
provided by an app-level middleware satisfies `c.get` for **every** route, not only
routes that list the provider in `use:`. The amendment preserves the rule's
zero-false-positive contract by treating an unresolvable global entry as
indeterminate.

- `kata/scoped-slot-not-provided` (ADR-0004) — *amended by #88*: app-level
  `middlewares` providers count as provided for all routes.
