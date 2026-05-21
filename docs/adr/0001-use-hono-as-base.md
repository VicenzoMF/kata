# ADR-0001: Use Hono as the HTTP base

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

Kata needs an HTTP layer with:

- Cross-runtime support (Node, Bun, Deno, Cloudflare Workers, edge).
- End-to-end type safety (server → client RPC).
- Minimal cold start (sub-millisecond on edge).
- Active ecosystem, not maintenance-mode.

The candidates are Express, Fastify, Hono, and Elysia.

## Decision

We will build Kata on top of **Hono**. Kata wraps Hono's router and context
object, but does not re-export Hono's API surface — Kata's public API is a
constrained subset (`defineRoute`, `defineContext`, `defineMiddleware`,
`createApp`) plus Hono's RPC client for type inference on the consumer side.

## Alternatives considered

### Express
Rejected. Synchronous middleware model, no native types, no edge runtime support,
slow request handling relative to modern alternatives. Maintenance-mode v5.

### Fastify
Rejected. Strong perf and a real plugin model, but tightly coupled to Node — no
first-class edge / Workers / Deno support. The plugin lifecycle model would
fight Kata's constraint of statically enumerable deps.

### Elysia
Rejected for now. Excellent ergonomics and end-to-end types, but locked to the
Bun runtime. Kata aims to be portable across Node / Bun / Deno / edge from day
one. We re-evaluate if Bun becomes the dominant runtime.

### Build our own router
Rejected. Reinventing routing, body parsing, and edge adapters consumes the
budget that should go into Kata's actual differentiators (the harness, the DI
model, the verifier).

## Consequences

### Positive
- Cross-runtime portability is free.
- Type-safe RPC client comes for free via `hc<typeof app>`.
- Hono's middleware model maps cleanly to Kata's `defineMiddleware`.
- Performance baseline is among the best in the JS ecosystem.

### Negative / costs
- Kata depends on Hono's release cadence and API stability. Lock to a major
  version range and re-test on each Hono major.
- Hono's permissive context (`c.set('x', anything)`) must be wrapped to enforce
  Kata's scoped-slot model (see ADR-0004).
- Users coming from Express / Nest will have to learn Hono's context object.

### Follow-ups
- Pick a minimum Hono version (likely `^4`).
- Decide adapter strategy for Node vs. Bun vs. Workers (separate entry points).
- Draft ADR for RPC client export shape.

## Companion rules

No direct lint rules from this ADR. Downstream ADRs will use Hono primitives
under the hood; their rules belong to those ADRs.
