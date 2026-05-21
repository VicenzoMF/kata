# ADR-0005: DTOs live in `<domain>.schema.ts`, not inline in routes

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

Zod (or any schema lib) lets you define schemas inline in route files:

```ts
defineRoute({
  input: { body: z.object({ name: z.string(), email: z.string().email() }) },
  output: z.object({ id: z.string(), name: z.string(), email: z.string().email() }),
  // ...
})
```

For tiny apps this reads well. As soon as schemas are shared (a `User` shape
used by `GET /users/:id`, `POST /users`, and `PATCH /users/:id`), inline schemas
either get duplicated or get extracted ad-hoc to wherever felt convenient. The
OpenAI engineering team's pattern, observed in their internal harness, is to
keep DTOs in a dedicated colocated file so agents can both find them by glob
and reuse them by name. Their custom lint enforces the location.

Kata adopts the same pattern.

## Decision

Every domain's Zod schemas live in `src/modules/<domain>/<domain>.schema.ts`.
Routes import schemas by name; inline schema literals in `.route.ts` are a
lint error.

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
})

export const CreateUserInputSchema = z.object({
  name: z.string(),
  email: z.string().email(),
})

export type User = z.infer<typeof UserSchema>
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>
```

```ts
// src/modules/users/users.route.ts
import { defineRoute } from 'kata'
import { z } from 'zod'
import { UserSchema, CreateUserInputSchema } from './users.schema'

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserInputSchema },
  output: UserSchema,
  // ...
})
```

Naming conventions:
- `*Schema` for Zod schemas.
- `*Input` / `*Output` types are inferred via `z.infer`.
- Shared schemas across domains live in `src/shared/schemas/` (rare).

## Alternatives considered

### Inline schemas in `.route.ts`
Rejected. Encourages duplication, blocks reuse, and makes "find all uses of the
User shape" a fuzzy grep instead of an exact symbol search.

### Single global `src/schemas/` directory
Rejected. Conflicts with the per-module file layout (ADR / route / service /
schema co-located). Cross-module grep becomes the only way to find a schema —
weaker than "in the same folder as the route that uses it".

### Auto-extraction at build time
Rejected. Adds a build step for ergonomic sugar that costs verification clarity.

## Consequences

### Positive
- Schemas are findable by glob: `src/modules/**/*.schema.ts`.
- `grep "UserSchema"` returns every place that uses the User contract.
- DTO reuse is trivial — both the route and the service import from
  `./<domain>.schema`.
- `z.infer` types live next to the schemas they describe, so a single import
  pulls both runtime and compile-time contracts.

### Negative / costs
- One extra file per domain. Mitigated by the mandatory folder layout that
  expects this file anyway.
- For routes with one-off, never-reused schemas, the indirection feels heavy.
  Accepted: consistency > local convenience, per the constraint-as-feature
  philosophy.

### Follow-ups
- Lint rule `kata/inline-schema` — `z.object(...)` (or any `z.*(...)` call
  composing a schema) appearing inside `.route.ts` or `.service.ts` is an
  error. Allowed in `.schema.ts` only.
- Cookbook entry: cross-domain schema sharing via `src/shared/schemas/`.

## Companion rules

- `kata/inline-schema` — Zod schema composition outside `*.schema.ts`.
- `kata/schema-file-naming` — schemas must live in
  `src/modules/<domain>/<domain>.schema.ts` (file name matches parent folder).
