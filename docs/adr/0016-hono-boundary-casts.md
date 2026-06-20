# ADR-0016: Hono Type Boundary Casts

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Agent

## Context

ADR-0002 bans the use of `any` and emphasizes type safety throughout the Kata pipeline. However, Hono has an extremely strict typing boundary for the `c.json()` and `c.get()` / `c.set()` context functions. In Kata, the runtime pipeline uses an array of plugins, error handlers, and contexts, creating unavoidable type mismatches at the Hono border where we must bridge Kata's internal abstractions with Hono's specific requirements.

Currently, we rely on inline `as never` and `as unknown as` casts in multiple places (specifically in `context.ts`). We need a sanctioned pattern for treating these unavoidable casts, ensuring they do not spread across the codebase unintentionally while acknowledging they are required at the framework boundary.

## Decision

We will keep the `as never` and `as unknown as` casts inline where they interface with Hono, but require a special `// kata-allow: hono-boundary` marker immediately preceding each cast.

Detail:
- Raw casts (`as never`, `as unknown as`) without the marker are considered violations.
- A verify rule, `kata/no-raw-boundary-cast`, will be introduced to statically enforce this requirement across the codebase.
- The marker visually flags the boundary, ensuring developers know exactly why the cast exists (interfacing with Hono).

## Alternatives considered

### Alternative A — Bless a single hono-bridge.ts shim
Create a single module with `typedJson(c, body, status)`, `typedGet(c, key)`, and `typedSet(c, key, value)` and ban `as never` everywhere else.
*Why rejected:* Centralizing the casts into a single shim adds indirection. Given that `context.ts` is effectively the bridge already, introducing another shim layer creates unnecessary cognitive overhead. The inline marker approach provides immediate context where the cast occurs.

### Alternative B — Status quo
Document the necessity of these casts without programmatic enforcement.
*Why rejected:* Over time, `as never` could quietly leak into other parts of the application. Without a verify rule, developers might use it to bypass the type checker for domain code, undermining ADR-0002.

## Consequences

### Positive
- Enforces awareness of Hono boundary constraints.
- Prevents raw type casts from leaking into domain code.
- Visually explains the purpose of the cast to anyone reading the code.
- Explicit cross-reference to ADR-0002 via the exception marker.

### Negative / costs
- A slight increase in verbosity where Hono interacts with Kata's pipeline.

### Follow-ups
- Implement `kata/no-raw-boundary-cast` verify rule.
- Apply `// kata-allow: hono-boundary` to the ~20 existing violations in `context.ts`.

## Companion rules

Mechanical enforcement of this ADR lives in `no-raw-boundary-cast.ts` (archgate pattern).
Rule IDs introduced by this ADR:

- `kata/no-raw-boundary-cast` — Disallows `as never` and `as unknown as` type casts unless preceded by a `// kata-allow: hono-boundary` comment.
