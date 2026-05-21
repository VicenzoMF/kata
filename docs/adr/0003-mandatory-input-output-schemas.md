# ADR-0003: Every route declares input and output schemas

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

End-to-end type safety in HTTP frameworks comes from two things: a schema for
what enters a route (params / query / body / headers) and a schema for what
leaves it (response body). Many frameworks make either or both optional. When
they are optional:

- RPC clients cannot infer return types and fall back to `unknown` / `any`.
- Responses bypass runtime validation; bugs (returning the wrong shape) leak
  silently to clients.
- A static verifier (`kata verify`) cannot prove "this endpoint matches its
  documented contract", because there is no contract.

Optional schemas also pollute the agent's decision space: "should I add a
schema here?" is exactly the kind of judgment call that the constraint-as-
feature philosophy (Birgitta Böckeler, OpenAI engineering blog) wants to
eliminate.

## Decision

Every route declared via `defineRoute` **must** include:

- `input` — an object containing any of `{ params, query, body, headers }`,
  each a Zod schema. The shape is determined by which of these the route reads.
- `output` — a single Zod schema describing the response body for the success
  case.

Compile-time: the `defineRoute` type signature requires both fields. Omitting
them is a TypeScript error.

Runtime: Kata validates `input` before invoking the handler (422 on failure)
and validates `output` after the handler returns (500 on failure, with a
verbose log entry pointing at the offending route).

Lint-time: `kata verify` checks that no route in `src/modules/**/*.route.ts`
is missing either field, even if the user disables strict TS for some reason.

## Alternatives considered

### Optional output schema
Rejected. Without it, `hc<typeof app>` cannot infer return types and the RPC
client contract degrades. The runtime validation of outputs also catches a
common bug class where the handler "almost" returns the right shape.

### Schema only on input (some popular frameworks)
Rejected. Same reason as above for outputs. Also: agents are observed to be
particularly bad at returning the right response shape on the first try — output
validation is high-value harness coverage.

### Multiple output schemas keyed by status code
Deferred. v1 supports a single success-case schema. Multiple status-code
schemas (e.g., `200: User, 404: ErrorShape`) is a likely follow-up ADR once we
see real usage.

## Consequences

### Positive
- `hc<typeof app>` returns precisely typed responses with no manual generics.
- A `kata verify` run can answer "are all routes contract-complete?" in
  milliseconds via a glob + AST shape match.
- Runtime catches "handler returned the wrong shape" before it reaches a client.

### Negative / costs
- Slightly more boilerplate per route. Mitigated by `<domain>.schema.ts`
  co-location (ADR-0005), so the schema definition is one import away.
- Discriminated-union responses (different shapes per status) need the v2
  multi-schema follow-up. Workaround for v1: a wide union output schema.

### Follow-ups
- Lint rule `kata/no-route-without-output-schema`.
- Lint rule `kata/no-route-without-input-schema` (skip if the route reads
  none of params / query / body / headers — still requires `input: {}` to be
  explicit).
- Lint rule `kata/inline-schema` enforcing ADR-0005 (schemas live in
  `<domain>.schema.ts`).
- Design `defineRoute` so its TS signature makes both fields mandatory.

## Companion rules

- `kata/no-route-without-output-schema` — every `defineRoute` call has `output`.
- `kata/no-route-without-input-schema` — every `defineRoute` call has `input`
  (may be an empty object literal).
- `kata/output-shape-mismatch` (runtime, not lint) — handler return value fails
  `output.safeParse`.
