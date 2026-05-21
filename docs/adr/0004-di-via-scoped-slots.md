# ADR-0004: DI via a central registry of singletons and scoped slots

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

Every web app has two kinds of dependency:

- **Singletons** — live for the process lifetime: db pool, logger, cache, mailer.
- **Request-scoped** — one instance per HTTP request: current user, tenant id,
  request id, active transaction, trace context.

A Kata route handler reaches both via `c.get('key')`. The DI model determines
whether `c.get` can be statically verified by a fast PostToolUse hook. Three
shapes were considered:

- **Pattern A** — only singletons; request-state via Hono's `c.set` / `c.var`.
- **Pattern B** — singletons + factories: `c.get('user')` may invoke a factory
  that returns `T | Promise<T>`, memoized per request.
- **Pattern C** — singletons + typed slots: scoped slots are declared upfront
  but must be populated by a middleware whose `provides` field is checked
  against the route's `use` chain.

## Decision

Kata adopts **Pattern C**.

```ts
import { defineContext, singleton, scoped } from 'kata'

export const context = defineContext({
  db:       singleton(makeDB(env)),
  logger:   singleton(makeLogger()),
  user:     scoped<User>(),
  tenantId: scoped<string>(),
})
```

Middlewares declare which scoped slots they populate:

```ts
export const authMiddleware = defineMiddleware({
  provides: ['user', 'tenantId'] as const,
  handler: async (c, next) => {
    c.set('user', await getUserFromJWT(c))
    c.set('tenantId', c.get('user').tenantId)
    await next()
  },
})
```

Routes declare which middlewares run, in order:

```ts
defineRoute({
  method: 'GET',
  path: '/me',
  use: [authMiddleware],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('user'),
})
```

`c.get('key')` always returns `T` (never `Promise<T>`, never `T | undefined`).
Reading a scoped slot whose providing middleware did not run is rejected at
lint time, not at runtime.

## Alternatives considered

### Pattern A — singletons only, request state via `c.set` / `c.var`
Rejected. Two parallel mechanisms (`c.get(singleton)` vs `c.var.scopedThing`)
double the mental model. Hono's `c.var` typing requires manually maintained
generics that the harness cannot verify in milliseconds.

### Pattern B — singletons + factories
Rejected. `c.get` would return `T` for some keys and `Promise<T>` for others,
forcing a conditional return type that pollutes inference. Factory dependency
graphs invite cycles and ordering bugs. The verifier loses its "single grep
answers the question" property: to know whether route X uses `user`, we'd need
to resolve factory call graphs, not just glob `c.get('user')`.

## Consequences

### Positive
- `c.get` is monomorphic — always returns `T`, sync. Inference stays simple.
- Static enumeration of available keys is one grep against `src/context.ts`.
- A new mechanical rule becomes possible: **every scoped read has a providing
  middleware in its `use:` chain**. This is the kind of multi-file invariant
  the harness moat depends on.
- Failure modes are explicit: an auth middleware that fails throws or short-
  circuits — it cannot leak an unset slot into the handler.

### Negative / costs
- Routes are slightly more verbose — `use: [authMiddleware]` is now mandatory
  for routes that read scoped slots. Trade-off accepted: explicit dependency
  trace > implicit factory resolution.
- The framework runtime needs to track per-request slot storage. Implementation
  cost is small (a Map per request) but non-zero vs. Pattern A.
- Slots are not lazy: if a middleware always runs, its slot is always populated,
  even when the route never reads it. (A future ADR may add lazy slots if the
  cost becomes measurable.)

### Follow-ups
- `defineMiddleware` API design (`provides: readonly string[]`).
- Lint rule `kata/scoped-slot-not-provided` — route reads `c.get('x')` where
  `'x'` is a scoped slot, but no middleware in `use:` lists `'x'` in `provides`.
- Lint rule `kata/middleware-provides-mismatch` — middleware declares
  `provides: ['x']` but does not call `c.set('x', ...)`.
- Lint rule `kata/scoped-read-outside-request` — `c.get('scopedKey')` outside
  a request handler (e.g., at module load) is a build-time error.
- Decide how dependent slots compose (e.g., `tenantId` depending on `user`)
  in middleware ordering — likely "order in the `use:` array is the contract".

## Companion rules

- `kata/scoped-slot-not-provided`
- `kata/middleware-provides-mismatch`
- `kata/scoped-read-outside-request`
- `kata/context-key-not-registered` — `c.get('foo')` where `'foo'` is not a key
  of `defineContext({...})`.
