# ADR-0024: Non-JSON output contracts (`raw()`) and a unified `Response` validation path

- **Status:** Accepted
- **Date:** 2026-08-18
- **Deciders:** @VicenzoMF

## Context

ADR-0003 makes `output` mandatory and Kata sells it as "responses are validated at
runtime (500 on mismatch) and `hc<typeof app>` infers return types from it." That
promise never held for a route that returns a `Response` directly — the only way to
serve a non-JSON body:

| declaration | handler returns | result |
|---|---|---|
| `output: z.string()` | the string | `content-type: application/json` — CSV delivered as a JSON string literal |
| `output: z.string()` | `new Response(csv, {headers})` | correct `text/csv` — the only thing that worked |
| `output: z.number()` **(a flat lie)** | the same `Response` | 200, identical correct CSV. `verify` clean, `tsc` clean, runtime silent |

Two bugs produced this, in two different code paths:

- **Single-schema form.** `buildResponse` treated any `Response` return as an
  unconditional short-circuit: `!isZodSchema(output)` is `false` for a single
  schema, so validation was skipped entirely. This was even documented as a
  feature ("a custom header or content type the handler set is preserved").
- **Map form (ADR-0011).** `validateResponseBody` tried, via
  `response.clone().json()`, and on a non-JSON body silently returned the
  response unchanged — so a CSV was unvalidatable in *both* forms, and the two
  forms disagreed about whether a `Response` was checked at all.

`rpc.ts` compounded this: `outputFormat` was hardcoded to `'json'`, so `hc<typeof
app>` always typed an endpoint as JSON. A typed client calling a non-JSON route
called `.json()` on a `text/csv` body and threw. `RouteHandlerReturn<O> =
SuccessOutput<O> | Response` was the only place the escape hatch was documented —
a type alias, not the README or guide.

A mandatory field that cannot be wrong is worse than an optional one: it reads as
a guarantee.

## Decision

### 1. `raw()` — a declared non-JSON contract

`output` grows a second kind of entry alongside a plain Zod schema:

```ts
export type RawOutput<T extends z.ZodTypeAny = z.ZodTypeAny> = {
  readonly __kata: 'raw'
  readonly contentType: string
  readonly schema: T
}

export function raw<T extends z.ZodTypeAny>(contentType: string, schema: T): RawOutput<T>

export type OutputEntry = z.ZodTypeAny | RawOutput
export type OutputMap = { readonly [status: number]: OutputEntry }
export type OutputSpec = OutputEntry | OutputMap
```

`raw('text/csv', z.string())` declares the response's `content-type` and a schema
for its **text** body (not JSON). It slots in anywhere an entry was accepted
before — the single-entry shorthand or a status key in the map:

```ts
output: raw('text/csv', z.string())                       // single entry
output: { 200: raw('text/csv', z.string()), 404: ErrorBodySchema } // map
```

### 2. The escape hatch becomes declared, not implicit, at the type level

`RouteHandlerReturn<O>` now derives what a handler may return from what `O`
actually is:

```ts
export type RouteHandlerReturn<O extends OutputSpec> = O extends RawOutput
  ? Response
  : O extends z.ZodTypeAny
    ? SuccessOutput<O>
    : SuccessOutput<O> | Response
```

- **`O` is a single `raw()` entry** → only a `Response` satisfies it (no
  plain-value equivalent exists).
- **`O` is a single plain Zod schema** → only the plain value satisfies it. A
  bare `Response` is now a `tsc` error — this is the change that closes the hole,
  and it is deliberately narrower than "forbid `Response` everywhere": see
  *Alternative B* for why a blanket ban was rejected.
- **`O` is a map** → unchanged from ADR-0011 (`SuccessOutput<O> | Response`): a
  plain value for a declared `200`, or a `Response` for any status, declared or
  not. This is still how `c.error`/`c.json(body, status)` work, and still how an
  undeclared status (a `401` from an auth middleware, a redirect) passes through.

### 3. Unify single-entry and map validation of a `Response`

Both forms are now read through one lookup that treats a single entry as sugar for
`{ 200: entry }`:

```ts
function entryForStatus(output: OutputSpec, status: number): OutputEntry | undefined {
  if (isOutputEntry(output)) return status === SUCCESS_STATUS ? output : undefined
  return output[status]
}
```

`buildResponse` calls this for every `Response` return, regardless of form. A
**declared** status is validated — as JSON (`validateResponseBody`, unchanged
shape check from ADR-0011) or, for a `raw` entry, as text against its
content-type + schema (`validateRawResponseBody`, new). An **undeclared** status
passes through unvalidated, exactly as ADR-0011 already allowed.

This closes the original bug directly: `output: z.string()` is now `{ 200:
z.string() }` for lookup purposes, so a `Response` returned at its default status
(200) — exactly the CSV exploit — is validated as JSON, fails (CSV text is not
valid JSON), and 500s in `strict`. To serve real CSV, the route must declare
`raw('text/csv', z.string())`, which the type system now also requires the
handler to honour.

### 4. `raw()` validation: content-type always, body only in `strict`

```
declared status?  →  no  →  pass through unvalidated
       │ yes
content-type matches (params ignored)?  →  no  →  strict: 500 / log: log + pass through
       │ yes
mode === 'strict'?  →  no  →  pass through (body never read)
       │ yes
clone().text() matches schema?  →  no  →  500
       │ yes
pass through
```

Content-type comparison is a header read — cheap, so it runs whenever the mode is
not `off`. Body comparison needs `response.clone().text()`, which buffers the
whole response into memory; that cost is paid only in `strict`. A route serving a
large download must never pay it in `log` (the production default) — Kata will
never silently buffer a stream-backed response outside `strict`. Because that
means the body genuinely goes unchecked in `log` (content-type still is) — and
neither goes checked at all in `off`, an explicit, documented full opt-out
(ADR-0009) that needs no per-route reminder — `registerRoute` logs one
`logger.warn` per route at startup (not per request) specifically when the
resolved mode is `log` and the route declares a `raw()` entry, so that one real
gap is visible instead of silent.

### 5. Fix the RPC bridge

`outputFormat` is derived per entry instead of hardcoded:

```ts
type MapEntryEndpoint<I, E, S extends number> = E extends RawOutput<infer T extends z.ZodTypeAny>
  ? HonoEndpoint<I, z.infer<T>, S, 'text'>
  : E extends z.ZodTypeAny
    ? HonoEndpoint<I, z.infer<E>, S, 'json'>
    : never
```

`hc<typeof app>` now types a `raw()` endpoint's client response with `.text():
Promise<T>` and `.json(): Promise<never>` — calling `.json()` on a CSV endpoint is
a compile error, not a runtime `SyntaxError`.

### 6. Documentation

`docs/guide/routes-schemas.md` gets a "Non-JSON responses: `raw()`" section and a
rewritten "Validating a `Response`" section describing the unified lookup;
`packages/kata/README.md` gets a short mention. No more "output is unenforced for
`Response` returns" caveat — the caveat is fixed, not just documented.

## A structural-typing caveat (known, accepted)

TypeScript is structural: `Response` (the DOM type) has real properties named
`ok`, `status`, `statusText`, `headers`, `body`, `bodyUsed`, `redirected`, `type`,
`url`. If a plain output schema's shape happens to be a subset of those — e.g.
`z.object({ ok: z.boolean() })` — a `Response` value is structurally assignable to
it, and `RouteHandlerReturn`'s new restriction does not catch it at the type
level. This is a narrow, coincidental gap inherent to structural typing, not a
flaw in the mechanism: it requires a schema whose field names *and* types happen
to alias `Response`'s own shape, which is unlikely by accident for a real domain
object. It is called out here rather than left for someone to discover; no
mitigation is proposed (a nominal brand on `Response` is not something Kata
controls).

`{ ok: boolean }` is exactly this shape, and it is a common convenience
placeholder — this codebase's own tests use it repeatedly. When a `Response`
slips through this gap at status 200, `entryForStatus`'s unify (point 3) treats
that status as declared and runtime-validates it as JSON, which means a
`clone().json()` read same as any other declared status. If that `Response`'s
body is a slow or intentionally-stalled stream — as one `context.test.ts`
fixture for the ADR-0020/issue #207 header-merge rebuild path turned out to be
— that read hangs the request until the body resolves, not just "validates
nothing." This is not a new hazard: `validateResponseBody`'s `clone().json()`
already carried it for any map-form route with a declared status (ADR-0011).
ADR-0024 widens *when* it can trigger (a single-schema route's own 200, via the
structural gap above) but does not introduce the underlying risk, and fixing
`clone().json()` against a hostile/slow body in general is a pre-existing,
orthogonal robustness gap this ADR does not take on. The one fixture that hit it
was updated to set `outputValidation: 'off'`, since it tests header merging, not
output validation.

## Alternatives considered

### Alternative A — validate a JSON schema against `clone().text()` too (no `raw()`)
Skip the new declaration; just make the existing schema's `safeParse` run against
whatever the body actually is (JSON-parsed if possible, else raw text). Rejected:
this reintroduces exactly the "z.number() passes for a CSV body" bug, since any
schema — right or wrong — would validate *something*. `raw()` makes the intent
(and the content-type) an explicit, checkable declaration instead of inferring it
from what happened to parse.

### Alternative B — forbid a bare `Response` for every output form, including maps
The blanket version of point 2: no `output` declaration, single or map, ever
allows a bare `Response` unless every status is enumerated. Rejected: it would
break the established, tested, and ADR-0011-sanctioned pattern of a map declaring
only its 200/success schema and letting `c.error`/an auth middleware answer
undeclared statuses untyped (`{ 200: OrderSchema }` + a `401` from `requireAuth`
that the route never sees or declares). That pattern is real and used throughout
the examples; forbidding it is a much larger, unjustified breaking change than the
bug being fixed calls for.

### Alternative C — a `kata verify` rule for the cases the type system cannot see
The original sketch for this issue proposed a static rule flagging a `raw()`
entry whose handler can't be proven to return a `Response` (untyped/loosely-typed
code, `as any` escapes). Deferred, not shipped: `RouteHandlerReturn` already
makes this a hard `tsc` error for all typed code reached through the public
`defineRoute` API, and the general "an `as never`/boundary cast needs a
`kata-allow: hono-boundary` comment" convention (`kata/no-raw-boundary-cast`)
already covers the escape-hatch case. A dedicated rule is listed under
Follow-ups rather than built speculatively.

### Alternative D — re-derive the escape hatch per status instead of per declaration
Let the type system infer, per possible response, whether a `Response` is legal
based on the *runtime* status value the handler is about to use. Rejected as
infeasible: TypeScript cannot see a `Response`'s runtime `status` at the type
level (`new Response(x, { status: 200 })` and `new Response(x, { status: 404 })`
are the same type). The declaration (single entry vs. map, which statuses a map
lists) is the only thing the type system can actually key off; Alternative B and
the chosen design both work within that constraint.

## Consequences

### Positive
- A route can serve a real non-JSON body — CSV, plain text, a download — with a
  declared, validated, RPC-typed contract instead of an undocumented escape hatch.
- The original bug (a wrong-typed schema silently "validating" a `Response`'s
  body) is closed for the case it was reported in: a plain schema's own status.
- Single-entry and map forms agree on whether and how a `Response` is checked —
  one lookup, one mental model, instead of two undocumented behaviours.
- `hc<typeof app>` cannot silently mistype a non-JSON endpoint as JSON anymore.
- Never buffers a stream-backed response outside `strict` — the buffering cost
  ADR-0011 already accepted for JSON `Response` validation is not widened to
  non-JSON bodies in production.

### Negative / costs
- **Breaking, deliberately.** A single-entry route (`output: SomeSchema`) that
  returned `c.error(...)`/`c.json(body, otherStatus)` for a second status no
  longer compiles; it must move to the map form (`output: { 200: SomeSchema, 404:
  ErrorBodySchema }`) — the same migration ADR-0011 already established for
  routes that want a non-200 body validated. Three example routes
  (`examples/shop`'s `getOrderRoute`/`getProductRoute`/`addCartItemRoute`) and the
  `kata init` scaffold's `getGreetingRoute` needed exactly this migration; several
  `packages/kata` unit tests using a placeholder `{ ok: z.boolean() }` schema were
  migrated too, for clarity, even though the structural-typing caveat above meant
  a few of them still happened to compile unchanged.
- Rebasing onto `main` surfaced a second, independent confirmation of the bug
  this ADR fixes: issue #207's own `examples/hello`'s `/export.csv` route
  (`diag.route.ts`) declared a plain `output: ExportCsvOutputSchema` and
  returned a raw CSV `Response` directly — the schema's own doc comment said,
  in so many words, "output validation never actually runs against this
  schema." Migrated to `raw('text/csv', ExportCsvOutputSchema)`, which is now
  genuinely checked. The rebase also surfaced one runtime interaction worth
  naming explicitly: a `context.test.ts` fixture for the ADR-0020/#207
  header-merge rebuild path returns a `Response` with a deliberately-stalled
  stream body against `output: z.object({ ok: z.boolean() })` (the structural
  gap above) — under the unify (point 3), that made the stream get `clone()`d
  for JSON validation and hang the test. Fixed by setting `outputValidation:
  'off'` on that fixture, since it tests header merging, not output
  validation; see the caveat section for why this is a pre-existing risk
  (ADR-0011) that ADR-0024 widens rather than introduces.
- `raw()`'s body validation is `strict`-only, so a production (`log`-mode) route
  gets no runtime guarantee that its non-JSON body matches its declared schema —
  only its content-type. Mitigated by the startup warning and by `strict` still
  being the dev/CI default, matching ADR-0009's own strict/log split.
- The structural-typing caveat above is a real, if narrow, gap the type system
  cannot close.
- One more branch in the runtime response-building pipeline (`entryForStatus`,
  `validateRawResponseBody`, `mediaType`). Bounded and unit-tested.

### Follow-ups
- `kata/raw-output-requires-response` (or similar) — the deferred `kata verify`
  rule from Alternative C, for handlers the type system cannot check.
- A structured metric/log channel for the startup "body unchecked outside strict"
  warning, mirroring the ADR-0009 follow-up for output-mismatch logging.
- Per-route `outputValidation` override (already an ADR-0009 follow-up) would let
  a specific `raw()` route opt into strict body-checking even under an app-wide
  `log` mode, without paying the buffering cost everywhere else.
- `docs/pt/guide/routes-schemas.md` (the Portuguese translation) still describes
  the pre-ADR-0024 behaviour and needs syncing.

## Companion rules

This ADR changes runtime behavior and a public type signature; it introduces no
mandatory mechanical lint rule for v1 — the type system is the primary
enforcement mechanism (`RouteHandlerReturn`), same posture ADR-0009 took for its
own runtime-only change. The rule worth drafting later is listed under
Follow-ups:

- `kata/raw-output-requires-response` (future) — flag a `raw()` output entry
  whose handler cannot be statically proven to return a `Response`.

## Note on numbering

Drafted 2026-08-18 as a repo-root `ADR-0022-draft.md` awaiting placement into
`docs/adr/`; the decision shipped in code (PR #223, issue #208) before the draft
was committed. By the time it was rediscovered (issue #261), the `0022` slot had
already been taken by [ADR-0022](/adr/0022-docs-mcp-lexical-search-over-vector-rag)
(docs-MCP lexical search). This file is that draft, otherwise unchanged, filed
under the next free number, `0024`.
