# ADR-0016: File-naming convention enforcement

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** @VicenzoMF

## Context

The Kata architecture mandates a specific folder layout and functional design. To keep modules cohesive and predictably structured, we employ a standard file-naming convention within each domain module. Specifically, files within `src/modules/<domain>/` should follow the `<domain>.{route,service,schema,hurl,test}.ts` pattern. 

For example, a `users` domain should have files like `users.route.ts`, `users.service.ts`, `users.schema.ts`, etc. Ad-hoc file names like `utils.ts`, `helpers.ts`, or arbitrarily named schemas like `auth.schema.ts` within the `users` domain dilute findability and introduce cognitive load when navigating the codebase.

## Decision

We formalize the `<domain>.{route,service,schema,hurl,test}.ts` convention for all files living inside `src/modules/<domain>/`.

- `*.route.ts` - For all route definitions and definitions of endpoint input/outputs.
- `*.service.ts` - For pure functions and business logic.
- `*.schema.ts` - For Zod DTO schemas and type inference (as described in ADR-0005).
- `*.hurl` - For API E2E tests.
- `*.test.ts` - For unit tests.

The filename must match the parent domain directory name. For instance, in `src/modules/orders/`, the schema file must be `orders.schema.ts` and not `order.schema.ts` or `order-dtos.schema.ts`.

## Alternatives considered

### Allow arbitrary filenames inside domains
Brief description: Developers can name files however they want within `src/modules/<domain>/`, as long as they contain the correct logic.
Why rejected: Reduces findability. When scanning globally for schemas via glob `*.schema.ts`, having inconsistently named files breaks expectations and complicates generic tooling or scripts.

### Use single global folders instead of domain-driven design
Brief description: Group by technical concern instead of business domain (e.g. `src/routes/`, `src/services/`, `src/schemas/`).
Why rejected: Conflicts with the core Kata architecture. Colocation by domain is non-negotiable as it increases feature cohesion.

## Consequences

### Positive
- Predictable structure: Every domain looks exactly the same.
- Glob-friendly: Tooling and scripts can confidently use `src/modules/**/*.schema.ts` or similar patterns.
- Reduced decision fatigue: Developers don't have to think about how to name files or organize code inside a module.

### Negative / costs
- Might require splitting very large domains if the single `service.ts` or `route.ts` becomes unmanageable, but this encourages keeping domains small and bounded.
- Strict enforcement might feel restrictive for small helpers, requiring them to either be inline or moved to a shared library.

### Follow-ups
- Lint rules to create: `kata/schema-file-naming`
- Tests to write: Verify the lint rule flags non-compliant schema file names.

## Companion rules

Mechanical enforcement of this ADR lives in `schema-file-naming.ts` (archgate pattern).
Rule IDs introduced by this ADR:

- `kata/schema-file-naming` — files within a domain module should be named `<domain>.<suffix>`
