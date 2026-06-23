# ADR-0016: Split `context.ts` into context / pipeline / response

- **Status:** Accepted
- **Date:** 2026-06-22
- **Deciders:** @VicenzoMF

## Context

`packages/kata/src/context.ts` has grown to 631 lines and now carries four
distinct responsibilities under one roof:

1. **Public surface** — the types every Kata app imports (`MiddlewareContext`,
   `RouteContext`, `Middleware`, `Route`, `Module`, `AppConfig`, the route
   type aliases) plus the entry points `defineContext`, `singleton`, `scoped`.
2. **Request pipeline** — `buildHonoApp`, `registerRoute`, the manual
   middleware `runChain` loop, `resolveRuntimeOptions`, the scoped-store plumbing
   (`getScopedStore`, `SCOPED_STORE`), `readInputs`, and the
   `makeMiddlewareContext` / `makeRouteContext` builders.
3. **Response construction + output validation** — `buildResponse`,
   `buildOutputResponse`, `validateResponseBody`, `errorResponse`,
   `logOutputMismatch`, `outputMismatchResponse`, and `finalizeResponse`.
4. **Shared route vocabulary** — `HttpMethod`, `InputSchemas`, `OutputSpec`,
   `OutputMap`, which `rpc.ts` imports type-only (`rpc.ts:17`), creating a
   `context.ts ↔ rpc.ts` import cycle (`context.ts:10` imports `KataApp` back
   from `rpc.ts`).

The file is the most-touched in the package — every accreted ADR (0008 error
envelope, 0009 output validation, 0011 multi-status, 0012 app-level middleware,
0004 scoped slots, #63 request-id/logging) added runtime to it. The four
concerns have weak coupling: the pipeline calls into response building through
a handful of functions, and nothing outside the file reaches past the public
surface. AGENTS.md mandates a one-concern-per-file layout for app modules
(`<domain>.route.ts` / `.service.ts` / `.schema.ts`); the framework's own core
should hold to the same standard.

The `context.ts ↔ rpc.ts` cycle is type-only and erased at compile time, so it
is benign at runtime — but it is real coupling in the type graph, and the split
is the right moment to break it cleanly rather than carry it forward.

This ADR records the decision and the target module boundaries. It implies **no
behaviour change**: every public export keeps its name and signature, the
`kata` barrel (`index.ts`) re-exports the same set, and all current tests
(`context.test.ts`, `pipeline.test.ts`, `multi-status.test.ts`,
`output-validation.test.ts`) import only through the public `defineContext`
factory, so they are unaffected by the internal reorganization.

## Decision

We will split `packages/kata/src/context.ts` along its four natural seams into
four files, and hoist the shared route types to break the `context ↔ rpc`
cycle. The public API and all observable runtime behaviour are unchanged.

### Target module boundaries

#### `route-types.ts` (new) — shared route vocabulary
The type-only definitions that both the public surface and the RPC bridge
depend on:

- `HttpMethod`, `InputSchemas`, `Infer`, `InferInput`
- `OutputMap`, `OutputSpec`, `SuccessOutput`, `RouteHandlerReturn`

Emits no runtime code. `context.ts` and `rpc.ts` both import *down* into it;
neither imports the other. This is what severs the cycle: `rpc.ts:17`'s
`import type { HttpMethod, InputSchemas, OutputMap, OutputSpec }` retargets from
`./context` to `./route-types`, and `context.ts` no longer needs a type back
from `rpc.ts` for these.

#### `context.ts` — public surface + entry points
The types and constructors an app author imports:

- Slot constructors: `singleton`, `scoped`
- Context/route shapes: `MiddlewareContext`, `Middleware`, `RouteContext`,
  `Route`, `Module`, `AppConfig`
- The `defineContext` factory and its returned `defineMiddleware`,
  `defineRoute`, `createApp` closures

`createApp` delegates to `buildHonoApp` from `pipeline.ts`. The `KataApp<Mods>`
type it returns is still imported type-only from `rpc.ts` — that single
remaining type edge is a one-directional dependency (`context → rpc`), not a
cycle, once the shared vocabulary moves to `route-types.ts`.

#### `pipeline.ts` (new) — request pipeline
The runtime that turns a registry + config into a wired Hono app:

- `buildHonoApp`, `registerRoute`, the `runChain` middleware loop
- `RuntimeOptions`, `resolveRuntimeOptions`
- Scoped store: `SCOPED_STORE`, `getScopedStore`
- Context builders: `makeMiddlewareContext`, `makeRouteContext`
- Input reading/validation: `readInputs`
- `finalizeResponse` (request-id echo + per-request log line)

Imports response construction from `response.ts` and shared types from
`route-types.ts` / `context.ts`.

#### `response.ts` (new) — response building + output validation
The success/error response layer (ADR-0008, ADR-0009, ADR-0011):

- `errorResponse` — the single funnel for every 4xx/5xx envelope
- `buildResponse`, `buildOutputResponse`, `validateResponseBody`
- `isZodSchema`, `SUCCESS_STATUS`
- `logOutputMismatch`, `outputMismatchResponse`

Depends only on `errors.ts`, `output-validation.ts`, and the shared route
types — it has no knowledge of the pipeline that calls it.

### Dependency direction after the split

```
route-types.ts        (leaf: pure types, no imports from this set)
   ▲        ▲
   │        │
context.ts  response.ts
   ▲          ▲
   │          │
   └── pipeline.ts ──┘
```

`rpc.ts` imports `route-types.ts` (down) — the former cycle is gone. No file in
the set imports `pipeline.ts`; it is the top of the graph, reached only through
`createApp`.

## Alternatives considered

### Alternative A — leave `context.ts` as one file
Rejected. 631 lines mixing four concerns is the package's worst hot-spot for
merge friction and the hardest file for an agent to navigate by glob. It also
violates the spirit of the mandatory per-concern layout the framework imposes
on its users.

### Alternative B — two-way split (types vs. runtime)
Split into `context.ts` (everything type + `defineContext`) and a single
`runtime.ts` (everything runtime). Rejected: it leaves the pipeline and the
response/output-validation layers — two genuinely separable concerns with a
narrow interface between them — fused in one large file, and it does nothing
for the `context ↔ rpc` cycle.

### Alternative C — split but keep the shared types in `context.ts`
Rejected. Keeping `HttpMethod` / `InputSchemas` / `OutputSpec` / `OutputMap` in
`context.ts` preserves the `context ↔ rpc` type cycle. Although the cycle is
benign (type-only, erased), the split is the cheapest moment to break it, and a
dedicated leaf module makes the shared vocabulary's role explicit.

### Alternative D — fold `response.ts` into `errors.ts`
Rejected. `errors.ts` owns the *envelope shape* (`buildErrorBody`,
`ErrorBodySchema`); `response.ts` owns *response construction and output
validation against route contracts*. Different concerns — the response layer
imports from `errors.ts`, not the reverse.

## Consequences

### Positive
- Each file owns one concern, matching the per-concern discipline AGENTS.md
  mandates for app modules.
- The `context.ts ↔ rpc.ts` type cycle is eliminated; the type graph becomes a
  DAG rooted at `route-types.ts`.
- Smaller, single-purpose files are easier for agents to locate by glob and to
  edit without merge collisions on the package's busiest file.
- `pipeline.test.ts` already exists and targets the pipeline behaviour — the
  test layout anticipates this seam.

### Negative / costs
- Four files where there was one; readers tracing a full request now cross
  module boundaries (`pipeline → response`). Mitigated by the clear, narrow
  interface (`buildResponse` / `errorResponse`) and the dependency-direction
  diagram above.
- A mechanical churn commit touching imports across `context`, `rpc`,
  `index.ts`, and the test files. Low risk: no signature changes, public
  barrel unchanged.

### Follow-ups
- Implementation PR performing the move (pure refactor; no behaviour change).
  Verify with `pnpm test` + `pnpm typecheck` — the public-API tests must pass
  untouched.
- Confirm `index.ts` re-exports the same symbol set after the move (the
  `from './context'` lines for the moved *types* may retarget to
  `./route-types`, but the exported names are identical).
- No new lint rule is required — this ADR records a structural decision, not a
  new constraint.

## Companion rules

None. This ADR records an internal module-boundary decision with no new
mechanical constraint to enforce, so there is no `0016.rules.ts`.
