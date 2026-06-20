# ADR-0016: Middleware ordering with provides dependencies

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** @VicenzoMF

## Context

ADR-0004 established the pattern for DI via scoped slots. Middlewares declare which slots they populate via the `provides` array and set them using `c.set()`. Routes then declare which middlewares they need using the `use:` array.

A question arises when one middleware depends on the scoped slots populated by another. For example, a `transaction` middleware might depend on a `tenantId`, which in turn might be populated by an `auth` middleware that sets a `user`. 

We need a clear contract on how these dependencies are resolved and whether a middleware can safely read (`c.get`) a scoped slot provided by another middleware.

## Decision

We will use the **order in the `use:` array as the strict contract** for middleware dependencies.

When a middleware reads a scoped slot (via `c.get`), that slot must have been populated by a preceding middleware in the same route's `use:` array, or in the app-level `middlewares` array (which runs before any route-level middlewares, as per ADR-0012). 

For example, if `authMiddleware` provides `user`, and `tenantMiddleware` provides `tenantId` by reading `c.get('user')`, the route must be defined as:

```ts
defineRoute({
  method: 'GET',
  path: '/data',
  use: [authMiddleware, tenantMiddleware],
  // ...
})
```

If the order is reversed, or if `authMiddleware` is missing, `tenantMiddleware` will fail at runtime when calling `c.get('user')`.

## Alternatives considered

### Alternative A — Middleware-level `dependsOn` array
Middlewares could declare a `dependsOn: ['user']` array, and the framework or harness could statically verify that the dependencies are met.
**Rejected:** This would add another layer of metadata to `defineMiddleware` and complicate the mental model. The `use:` array order is already an explicit, easily understood declarative sequence. 

### Alternative B — Dependency graph resolution
The framework could automatically order middlewares based on what they provide and what they consume.
**Rejected:** This breaks the predictability of execution order. Middlewares often have side effects beyond slot population (e.g., setting headers, logging, short-circuiting on errors). Automatic reordering based solely on slot dependencies would lead to subtle bugs and violates the "what you see is what executes" principle of the `use:` array.

## Consequences

### Positive
- **Predictability:** The execution order is exactly as written in the `use:` array. No magical reordering or hidden dependencies.
- **Simplicity:** No new APIs (`dependsOn`) or framework features are required.

### Negative / costs
- Developers must manually ensure the order of `use:` array is correct when middlewares have inter-dependencies.
- If a route's `use:` array order is incorrect, it will fail at runtime when the dependent middleware attempts to read an unset slot.

### Follow-ups
- Extend the `kata/scoped-slot-not-provided` rule (or create a new one like `kata/middleware-dependency-not-provided`) to scan `defineMiddleware` handlers for `c.get()` reads, verifying that any required scoped slots are provided by prior middlewares in the route's `use:` array or app-level middlewares.

## Companion rules

Mechanical enforcement of this ADR relies on the existing execution model, but can be enhanced with:
- Future rule: `kata/middleware-dependency-not-provided` — enforces that a middleware's `c.get` reads are satisfied by earlier middlewares in the `use:` chain.
