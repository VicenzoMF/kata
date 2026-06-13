# ADR-0008: Unified error response envelope

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** @VicenzoMF

## Context

Kata's success path is already contract-bound: ADR-0003 makes every route
declare an `output` schema, and the runtime validates the response body before
it leaves the handler. The **error** path has no such discipline. Today the
skeleton emits four hand-rolled shapes, each built inline with `c.json(...)`:

- `{ error: 'not_found' }` — 404, from a route handler (`users.route.ts`).
- `{ error: 'unauthorized' }` — 401, from the auth middleware.
- `{ error: 'validation_failed', issues: {...} }` — 422, from the input
  validator in `registerRoute`.
- `{ error: 'internal_output_shape_mismatch' }` — 500, from the output
  validator in `registerRoute`.

Each is fine in isolation, but there is no single declared shape, no helper, and
nothing stopping the next handler from inventing a fifth variant (`{ message }`,
`{ err }`, a bare string). For an RPC client — and for the harness that wants to
assert "all error responses look alike" — an unspecified error contract is the
same liability ADR-0003 identified for unspecified success contracts: clients
fall back to `unknown`, drift goes unnoticed, and a verifier has nothing to
check against.

This couples to issue #62 (global error boundary): once we catch arbitrary
thrown errors, they need a shape to serialise into. Deciding the shape (this
ADR, #18) must precede deciding the catch mechanism (#62).

## Decision

We will define **one** error envelope for every 4xx/5xx Kata produces, and a
context helper `c.error(code, message, extra?)` as the single sanctioned way to
build it.

### Envelope

```ts
type ErrorBody = {
  error: string                          // stable, machine-readable code
  message: string                        // human-readable description
  issues?: Record<string, FieldIssue[]>  // structured field errors, keyed by input source
}
```

- `error` — the machine-readable discriminator (`'not_found'`,
  `'validation_failed'`, `'internal_error'`, …). Kept under the field name
  `error` (not `code`) so the four existing shapes — and the Hurl assertions
  that pin them — stay valid. Clients switch on this; it never holds a human
  sentence.
- `message` — a human-readable description. **Required**: an error code with no
  explanation is exactly the "fill it in later" gap the constraint-as-feature
  philosophy (ADR-0003) removes.
- `issues` — present only when there are structured field errors (today: input
  validation). Reuses the `FieldIssue` shape and `formatZodIssues` serialiser
  shipped in #20, keyed by input source (`params` / `query` / `body` /
  `headers`).

### Helper

```ts
c.error(code: string, message: string, extra?: ErrorExtra): Response

type ErrorExtra = {
  status?: number                        // HTTP status; defaults to 400
  issues?: Record<string, FieldIssue[]>
}
```

`c.error` is available on **both** `RouteContext` and `MiddlewareContext` (the
401 path lives in middleware, the 404 in a handler). It builds the envelope via
the pure `buildErrorBody()` function in `errors.ts` and returns
`c.json(body, status)`. Envelope construction stays framework-agnostic and
unit-testable in `errors.ts`; only the `Response` wrapping touches Hono.

The parameter is named `code` (it is semantically the error code) while the wire
field is `error`. This rename is the single wart we accept for back-compat,
documented here so it is not mistaken for an oversight.

### Migration

All four existing shapes route through the helper / `buildErrorBody`:

| Was | Now |
|---|---|
| `c.json({ error: 'not_found' }, 404)` | `c.error('not_found', 'User not found', { status: 404 })` |
| `c.json({ error: 'unauthorized' }, 401)` | `c.error('unauthorized', 'Missing x-user-id header', { status: 401 })` |
| `c.json({ error: 'validation_failed', issues }, 422)` | `buildErrorBody('validation_failed', …, { status: 422, issues })` |
| `c.json({ error: 'internal_output_shape_mismatch' }, 500)` | `buildErrorBody('internal_output_shape_mismatch', …, { status: 500 })` |

Adding `message` is additive — existing clients keyed on `error` / `issues` are
unaffected.

### Relationship to #62

The global error boundary (#62) serialises any uncaught throw as
`c.error('internal_error', 'Internal server error', { status: 500 })` through
this same envelope, and `app.onError` uses the same `buildErrorBody`. The raw
error is logged server-side; the client never sees internal detail (see
Alternative D).

## Alternatives considered

### Alternative A — a separate `code` field alongside `error`
The issue floated `{ error, issues?, code? }`. Rejected: with `error` already
holding the machine code, a second `code` field is either redundant or forces
`error` to become the human message — which would break the existing
`$.error == "not_found"` Hurl assertions and every client switching on `error`.
One machine field (`error`) + one human field (`message`) is the smaller,
non-redundant shape.

### Alternative B — RFC 7807 Problem Details (`application/problem+json`)
A standardised `{ type, title, status, detail, instance }` body. Rejected for
v0.1: heavier than needed, introduces a non-JSON content type, and `type` URIs
imply a documentation surface we do not yet have. The chosen envelope is a
strict subset we can widen toward 7807 later without a breaking change (mostly
field renames). Noted as a follow-up.

### Alternative C — an open `extra` bag merged into the envelope
Letting `extra` be `Record<string, unknown>` spread into the body. Rejected: it
reintroduces "any shape goes" at the field level and defeats a future "all error
bodies match `ErrorBody`" lint. Structured additions (today `issues`) are
first-class, typed fields; new ones are added deliberately to the type,
consistent with ADR-0003's explicit-contract stance. `extra` is therefore a
closed, typed options object, not an open bag.

### Alternative D — include the thrown error's message in 500 bodies
Surfacing `err.message` (or the stack) aids debugging but leaks internals (DB
errors, file paths, secrets embedded in messages) to clients. Rejected as the
default: the boundary logs the full error server-side and returns a generic
`'Internal server error'`. Env-gated detail in development is a follow-up.

## Consequences

### Positive
- One shape for every error; RPC clients get a single `ErrorBody` to switch on.
- `c.error` is the obvious, typed path — handlers stop hand-rolling
  `c.json({ error: ... })`.
- Envelope construction is a pure function (`buildErrorBody`) — fully
  unit-testable without a server.
- Back-compatible: existing `error` / `issues` assertions and clients keep
  working; `message` is additive.
- Gives #62 a target shape and prevents internal-detail leakage by default.

### Negative / costs
- Parameter `code` maps to wire field `error` — a deliberate, documented bridge.
- `status` rides inside `extra` rather than as a positional argument, to keep the
  signature the issue specified (`c.error(code, message, extra?)`). Slightly less
  discoverable than a dedicated parameter.
- Still a single success schema per route (ADR-0003); status-keyed response
  schemas (e.g. `404: ErrorBody`) remain the deferred ADR-0003 follow-up.
  `c.error` is not yet validated against a per-route error schema.

### Follow-ups
- Lint rule `kata/no-adhoc-error-shape` — flag `c.json({ error: ... }, 4xx|5xx)`
  literals that should be `c.error(...)`.
- Env-gated error detail in development for the 500 path (Alternative D).
- Route `app.notFound` through the envelope too (unmatched-route 404s currently
  fall to Hono's default).
- Revisit RFC 7807 alignment (Alternative B) once an error-doc surface exists.

## Companion rules

Mechanical enforcement of this ADR will live in `0008.rules.ts` (archgate
pattern), to be implemented with the `kata verify` rule engine. Rule IDs
introduced by this ADR:

- `kata/no-adhoc-error-shape` — an error response (4xx/5xx) must be built via
  `c.error(...)`, not an inline `c.json({ error: ... })` literal.
