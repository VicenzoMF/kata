# ADR-0016: Hono version and adapter strategy

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** @VicenzoMF

## Context

Following ADR-0001 (Use Hono as the HTTP base), we need to formalize two critical details for the implementation:
1. Which major version of Hono Kata relies on.
2. How Kata applications are built and exported for different target runtimes (Node, Bun, Cloudflare Workers, Deno, etc.), given that different runtimes require different Hono adapters (e.g., `@hono/node-server`, direct `export default` for Bun/Workers).

## Decision

We will:
1. **Lock the minimum Hono version to major version 4 (`^4.0.0`)**. Kata's type system, RPC integration, and internal middleware wrappers are guaranteed to be compatible with Hono v4.
2. **Adopt a per-runtime entry point strategy**. Kata applications will be defined in a runtime-agnostic manner (e.g., in an `app.ts` file via `createApp`). The consumer will create runtime-specific entry files (e.g., `server.node.ts`, `server.bun.ts`) that import the agnostic app and bind it to the appropriate Hono adapter.

## Alternatives considered

### Single universal entry point
A single Kata build command that detects the runtime or bundles all adapters and conditionally boots the right one.
Rejected because of high complexity, bloated dependencies, and fighting the natural ecosystem patterns of tools like Vite, Cloudflare Wrangler, and standard Node execution.

### Kata-owned adapters
Kata could wrap `@hono/node-server` and other adapters, exposing a unified `serve(app, { runtime: 'node' })` function.
Rejected because it creates an unnecessary abstraction layer over Hono's mature adapters. By letting the consumer write the final entry point using standard Hono adapters, they retain full control over server lifecycle, port binding, and platform-specific options.

## Consequences

### Positive
- Kata core remains 100% platform-agnostic and lightweight.
- Consumers have total control over the server startup and shutdown lifecycle.
- Predictable compatibility with Hono's v4 ecosystem.

### Negative / costs
- Consumers must write a few lines of boilerplate for their specific runtime (the entry point file).
- The documentation must provide clear examples for the most common runtimes (Node, Bun, Cloudflare Workers).

### Follow-ups
- Create template entry points in the Kata CLI generator.
- Ensure documentation has examples for Node and Cloudflare Workers adapters.

## Companion rules

No direct lint rules from this ADR.
