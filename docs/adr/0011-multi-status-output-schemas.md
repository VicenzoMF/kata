# ADR-0011: Multi-status output schemas

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** @VicenzoMF

## Context

ADR-0003 made every route declare a single `output` Zod schema for the success
body, and the runtime validates the handler's return value against it. ADR-0003
itself deferred the obvious next step — *different shapes for different status
codes* — and named it explicitly:

> **Multiple output schemas keyed by status code.** Deferred. v1 supports a
> single success-case schema. Multiple status-code schemas (e.g.,
> `200: User, 404: ErrorShape`) is a likely follow-up ADR once we see real
> usage. […] Workaround for v1: a wide union output schema.

ADR-0008 (the unified error envelope) closed half the gap — every 4xx/5xx now
has *one* declared shape (`ErrorBody`) built through `c.error(...)`. But that
shape is only enforced by the helper, never by a route's own contract:

> Still a single success schema per route (ADR-0003); status-keyed response
> schemas (e.g. `404: ErrorBody`) remain the deferred ADR-0003 follow-up.
> `c.error` is not yet validated against a per-route error schema.

Two concrete costs of the single-schema model are visible in the examples today:

1. **Non-200 success bodies skip validation entirely.** `examples/shop`'s
   checkout returns `c.json(order, 201)` and carries this comment:
   *"Returning a Response short-circuits the pipeline (skipping output
   validation) — the framework's only way to set a non-200 status."* The 201
   body is never checked against `OrderSchema`.
2. **The RPC client can't see error responses.** `hc<typeof app>` derives every
   response as `status: 200` (see `rpc.ts`). A client calling `GET /users/:id`
   has no typed knowledge that a `404` with an `ErrorBody` is possible, so it
   cannot branch on it with type safety.

The forces: we want per-status contracts (typed *and* runtime-validated) without
breaking the single-schema routes that already exist, without abandoning the
"return a plain object **or** a `Response`" handler model, and while keeping the
Hono RPC bridge (epic #11) honest so `hc` infers per-status responses.

## Decision

We will let a route's `output` be **either** a single Zod schema (unchanged,
ADR-0003) **or** a map from HTTP status code to Zod schema:

```ts
// Back-compat — the single-schema form is exactly ADR-0003.
output: UserSchema

// New — a status→schema map.
output: { 200: UserSchema, 404: ErrorBodySchema }
```

```ts
type OutputMap = { readonly [status: number]: z.ZodTypeAny }
type OutputSpec = z.ZodTypeAny | OutputMap
```

### How the handler signals the status

The handler's two existing return modes are preserved; the status is read from
whichever one the handler uses, and the body is validated against the schema the
map declares for that status:

| Handler returns | Status | Validated against |
|---|---|---|
| a **plain value** (`return user`) | `200` | `output[200]` (or the single schema) |
| `c.json(body, status)` (a `Response`) | `status` | `output[status]` if declared |
| `c.error(code, msg, { status })` (a `Response`) | `status` | `output[status]` if declared |

The model is deliberately small: **a plain return is always the `200` body;
every other status is set explicitly with `c.json(body, status)` or
`c.error(...)`.** A map used with plain returns therefore declares `200`; if it
does not, the plain-return type is `never` and the handler must return a
`Response` (e.g. a create route that only ever answers `201`). We did not add
magic to infer "the one 2xx" as the plain-status — explicit beats ambiguous, and
it collapses the moment a route has two 2xx codes.

### Validation semantics (composes with ADR-0009)

The output-validation **mode** (`strict` / `log` / `off`, ADR-0009) is unchanged
and governs the *consequence* of a mismatch exactly as before. Multi-status only
widens *which* schema a given response is checked against:

- **Plain return** → validated against the success schema (`output[200]` for a
  map, or the single schema). `strict` 500s on a mismatch, `log` serves the data
  and logs, `off` skips. This is byte-for-byte the ADR-0003/0009 behavior.
- **`Response` return, map form** → if the response's `status` is a declared key
  and the mode is not `off`, Kata reads a **clone** of the body and validates it
  against `output[status]`. On success the **original `Response` is sent through
  verbatim** (status, headers, and bytes untouched). On a mismatch the mode
  applies: `strict` replaces it with the 500 `internal_output_shape_mismatch`
  envelope (ADR-0008); `log` logs and still serves the original.
- **`Response` return, declared-status absent** → passed through unvalidated. An
  undeclared status (e.g. a `401` produced by a middleware short-circuit, or a
  status the route simply didn't enumerate) is allowed and untyped, not an error.
- **`Response` return, single-schema form** → passed through unvalidated. This
  preserves today's exact behavior (a `Response` has always short-circuited
  output validation) and keeps the single-schema form a zero-cost migration.
- **Non-JSON / unreadable `Response` body** → validation is skipped (Kata only
  validates JSON it can parse).

Plain returns are re-serialized from the *parsed* value (Zod transforms apply, as
today); `Response` returns are validated as a **shape check** and forwarded
unchanged — Kata never re-serializes a `Response` the handler already built, so
it cannot silently drop a custom header or a transform the handler intended. This
asymmetry is intentional and documented rather than papered over.

### Declaring error statuses: `ErrorBodySchema`

Because `c.error(...)` always produces the ADR-0008 envelope, a route that wants
its `404`/`409`/`422` typed and validated needs a schema that *describes that
envelope*. Kata now ships one:

```ts
import { ErrorBodySchema } from 'kata'

output: { 200: UserSchema, 404: ErrorBodySchema }
```

`ErrorBodySchema` (and the `FieldIssueSchema` it builds on) is the Zod mirror of
the `ErrorBody` type from ADR-0008 — `z.infer<typeof ErrorBodySchema>` is
assignable to `ErrorBody`. It is the canonical thing to put behind an error
status; an app may substitute a stricter refinement (e.g. a literal `error` code)
when it wants the tighter contract.

### RPC typing (epic #11)

`rpc.ts` derives the Hono `Schema` from the modules tuple. For a single schema it
still emits one endpoint with `status: 200` (unchanged). For a map it emits a
**union of endpoints, one per declared status** — exactly the shape Hono itself
accumulates when a handler chains multiple `c.json(body, status)` calls. The
client then narrows by status with Hono's own helper:

```ts
const res = await client.users[':id'].$get({ param: { id } })
if (res.status === 404) {
  const { error } = await res.json() // ErrorBody — typed
  return null
}
return res.json()                    // User — typed
// InferResponseType<…$get, 200> === User
// InferResponseType<…$get, 404> === ErrorBody
```

### Breaking change

The value-level surface is backward compatible — a single `output: Schema` route
compiles and behaves exactly as before. The **type-level** surface changes, which
is why this is a breaking release:

- `Route`'s and `defineRoute`'s output generic widens from
  `O extends z.ZodTypeAny` to `O extends OutputSpec`.
- `RouteHandlerReturn<O>` is now `SuccessOutput<O> | Response` (was
  `z.infer<O> | Response`); for a single schema `SuccessOutput<O>` is `z.infer<O>`,
  so the common case is unchanged.
- `rpc.ts`'s derived endpoint type is a per-status union for map routes;
  `InferResponseType<call>` (no status argument) on a multi-status route is now a
  **union** of all status bodies. Code that assumed a bare
  `InferResponseType<call>` was the 200 body must pass the status:
  `InferResponseType<call, 200>`.

External code that parameterizes on these public types may need to adjust.

## Alternatives considered

### Alternative A — a single discriminated-union schema (status as a body field)
Keep one `output` schema, a `z.discriminatedUnion('status', …)`. Rejected: the
discriminant would be a *body* field, not the HTTP status line, so the wire status
stays unmodeled and the RPC client still can't narrow on `res.status`. It also
forces every response to carry a redundant `status` field. ADR-0003 already named
the status-keyed map as the intended shape.

### Alternative B — a tagged `{ status, body }` return value
Require handlers to `return { status: 404, body: … }` instead of using
`c.json`/`c.error`. Rejected: it discards the established "plain object **or**
`Response`" model and the `c.error` envelope ergonomics (ADR-0008), and is a far
larger breaking change for callers than widening `output`.

### Alternative C — validate every declared status, including middleware ones
Make the route responsible for declaring (and the runtime for validating) *every*
status it can emit, including a `401` from an auth middleware. Rejected: a
middleware short-circuit never passes through the handler-return path, so the
route cannot intercept it; forcing the route to enumerate statuses its middleware
chain produces couples the route to that chain. Undeclared statuses pass through
untouched instead.

### Alternative D — re-serialize `Response` bodies from the parsed data
On the `Response` path, rebuild the response from `schema.parse(body)` so Zod
transforms apply uniformly with the plain path. Rejected as the default: it would
drop any custom header the handler set and re-encode a body the handler already
serialized. Validating as a shape check and forwarding the original is less
surprising; transforms on non-200 bodies are rare. (An opt-in could revisit this.)

### Alternative E — compile-time-check `c.json(body, status)` against `output[status]`
Tighten `c.json` so its `body` argument must match the schema declared for its
`status`. Deferred: it requires threading the route's `O` into `RouteContext`
(today parameterized only by registry + input). The declared map already types
the *client*, and the runtime validates the *server* — v0.1 is covered. Additive
follow-up if usage calls for it.

## Consequences

### Positive
- Per-status response contracts are both **typed** (RPC client narrows on
  `res.status`) and **runtime-validated**, closing the two gaps above.
- The `201`/`4xx` "Response skips validation" hole is closed for any status a
  route declares — the shop checkout's workaround comment goes away.
- `ErrorBodySchema` gives error statuses a canonical, reusable schema, so the
  ADR-0008 envelope is now expressible in a route's `output` contract.
- Fully backward compatible at the value level: single-schema routes are
  untouched, so the migration is opt-in and incremental.

### Negative / costs
- One more shape for `output` and a small new type surface (`OutputSpec`,
  `OutputMap`, `SuccessOutput`). Bounded and documented.
- The `Response`-path validation reads a `clone()` of the body (a buffering cost),
  but only in the **map** form, only for a **declared** status, and only when the
  mode is not `off` — single-schema routes pay nothing new.
- Plain-vs-`Response` validation is asymmetric (re-serialize vs shape-check). A
  deliberate trade documented above.
- The single-schema form still does **not** validate `Response` returns — by
  design, to keep back-compat. Teams wanting `201` bodies validated opt into the
  map form.

### Follow-ups
- Teach a future `kata/output-status-map` lint to flag a map that is used with
  plain returns but omits `200` (today the type already makes that a `never`).
- Compile-time `c.json(body, status)` ↔ `output[status]` checking (Alternative E).
- Per-route output-validation mode (already an ADR-0009 follow-up) composes
  naturally with per-status schemas.
- Encourage `ErrorBodySchema` (or a refinement) for 4xx/5xx map entries via the
  planned `kata/no-adhoc-error-shape` rule (ADR-0008).

## Companion rules

This ADR widens a **type and runtime behavior**; it introduces no new mandatory
mechanical rule for v0.1. The existing `kata/no-route-without-output-schema`
(ADR-0003) already enforces that `output` is present and is satisfied by the map
form (it checks the key, not its shape). Rule IDs worth drafting later are listed
under Follow-ups:

- `kata/output-status-map` (future) — a status→schema map used with plain
  returns should declare a `200` entry.
