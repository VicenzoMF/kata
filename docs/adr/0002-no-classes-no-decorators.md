# ADR-0002: Fully functional API — no classes, no decorators

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

NestJS's primary ergonomic complaint is its heavy use of classes and decorators:
boilerplate `@Injectable()`, `@Controller()`, `@Module()`, complex inheritance
chains, IoC containers that resolve at runtime, and cold-start cost on edge
runtimes. The TC39 decorators proposal is reaching stable in TS 5+, but
decorators encourage hidden control flow that is hard to grep and hard for an
agent to verify mechanically.

Kata's thesis is that constraints aid agents. Functions, plain objects, and
explicit imports are mechanically inspectable; decorators are not.

## Decision

Kata's public API is **strictly functional**. The framework exposes only:

- Module-level functions: `defineRoute`, `defineMiddleware`, `defineContext`, `createApp`.
- Plain objects passed to them.
- Hono's request context `c` (wrapped for the scoped-slot DI model in ADR-0004).

No `@Decorator()`, no `class XController extends Y`, no metadata reflection, no
runtime IoC container.

A lint rule rejects `class` declarations and `@decorator` syntax inside `src/`,
with documented escape hatches (see "Negative" below) requiring an inline
allow-comment that references this ADR.

## Alternatives considered

### NestJS-style decorators + classes
Rejected. Hidden control flow (metadata at decoration time, runtime IoC),
cold-start cost from reflect-metadata, hard to grep, hard to mechanically
verify in a hook. Friction with edge runtimes.

### Optional classes (let users choose)
Rejected. If both styles are allowed, agents will produce both styles and the
codebase grows two parallel conventions. The harness moat depends on a single
predictable shape.

### Functional core, decorator sugar layer
Rejected for v1. The sugar layer would re-introduce the parsing complexity that
makes decorators hard to verify. Revisit only if a concrete pain point emerges
that functions cannot solve.

## Consequences

### Positive
- Mechanically inspectable: a route is `defineRoute({...})` and nothing else.
- Lint rules become trivial. `kata verify routes` is a glob + AST shape match.
- Lower cold-start cost. No reflect-metadata at boot.
- Trivial to test: route handlers are plain async functions.

### Negative / costs
- Some patterns familiar to Nest users (lifecycle hooks via class methods,
  guards via decorator) need to be expressed differently. Documented in the
  cookbook (TBD).
- Third-party classes (ORMs like Prisma, MikroORM models) are still classes;
  the ban applies to **Kata-owned code**, not to vendored types.
- Decorator syntax for third-party-required cases (e.g., TypeORM entities) is
  an escape hatch behind an inline `// kata-allow: class-required-by-vendor`
  comment.

### Follow-ups
- Lint rule `kata/no-class` (reject `class` in `src/**`).
- Lint rule `kata/no-decorator` (reject `@` decorator syntax in `src/**`).
- Cookbook entry: "Migrating from NestJS — guards, interceptors, pipes as functions".

## Companion rules

- `kata/no-class` — `class` declaration in `src/` unless preceded by
  `// kata-allow: class-required-by-vendor` comment that references an ADR
  or third-party requirement.
- `kata/no-decorator` — TC39 / experimental decorator syntax in `src/`. Same
  escape hatch as above.
