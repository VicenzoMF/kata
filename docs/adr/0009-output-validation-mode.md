# ADR-0009: Output validation mode (strict / log / off)

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** @VicenzoMF

## Context

ADR-0003 makes every route declare an `output` schema, and the runtime validates
the handler's return value against it before the response leaves the pipeline.
Today that validation has exactly one behaviour: on a mismatch the runtime logs
the Zod issues and returns a 500 `internal_output_shape_mismatch` envelope
(ADR-0008). The response body is never allowed to violate its declared contract.

That is the right default in development and CI — a handler returning the wrong
shape is a bug, and failing loudly is the fast-feedback the harness exists to
provide. In **production** the same policy is a liability: a benign drift (an
extra field, a newly-nullable column, a number where the schema still says
string) turns a working endpoint into a hard 500 for every caller. Availability
is usually worth more than contract purity at runtime, *provided the drift is
still recorded* so it gets fixed.

So the behaviour on mismatch should depend on the environment. The contract
itself (ADR-0003) does not change — every route still declares `input` and
`output`; only the *consequence* of an output mismatch becomes configurable.

## Decision

We will add an app-level **output validation mode** with three values, resolved
once per app at `createApp`:

```ts
type OutputValidationMode = 'strict' | 'log' | 'off'

createApp({ modules, outputValidation: 'strict' })
```

Behaviour on the **success path** is identical for `strict` and `log`: the
parsed (and Zod-transformed) data is sent. They differ only on a **mismatch**:

| Mode     | On mismatch                                                              | Intended environment |
|----------|-------------------------------------------------------------------------|----------------------|
| `strict` | Log the issues, return 500 `internal_output_shape_mismatch` (today).    | dev / test / CI      |
| `log`    | Log the issues, send the handler's data through unchanged (its status). | production           |
| `off`    | Skip output validation entirely — no `safeParse`, data passes through.  | perf-critical opt-out |

- `strict` is the status quo and the only mode that *guarantees* the wire body
  matches the declared schema.
- `log` keeps the endpoint serving while making the drift observable — the same
  `console.error` diagnostic strict emits, minus the 500.
- `off` removes the `safeParse` cost (and any Zod transform) for routes where
  validation is not wanted; it is an explicit escape hatch, not a default.

### Resolution precedence (config / env)

The mode is resolved by `resolveOutputValidationMode` (pure, unit-tested) in
this order, first match wins:

1. The explicit `outputValidation` passed to `createApp`.
2. The `KATA_OUTPUT_VALIDATION` environment variable, if it names a valid mode.
3. Derived from `NODE_ENV`: `production` → `log`, anything else → `strict`.

This gives a safe default in both directions — tight feedback in dev, resilient
serving in prod — while letting an app pin the mode explicitly or flip it per
deployment without a code change.

## Alternatives considered

### Alternative A — keep always-strict (status quo)
Reject every output mismatch with a 500 in all environments. Rejected: a benign,
backwards-compatible drift should not take down live traffic when the safer
move is to serve the response and record the mismatch. Strict remains the
*default for non-production*, so the dev/CI feedback loop is unchanged.

### Alternative B — a boolean flag (`validateOutput: true | false`)
Two states only: validate-and-500, or skip. Rejected: it cannot express the
middle ground that is the entire point in production — *validate, record, but
still serve*. Three named modes make the intent explicit at the call site.

### Alternative C — per-route override
Let each `defineRoute` set its own mode. Deferred: app-level resolution covers
the v0.1 need (the environment, not the individual route, drives the policy).
A per-route override is an additive follow-up if real usage demands it.

### Alternative D — surface the mismatch detail to the client in `log` mode
Include the Zod issues in the response. Rejected for the same reason ADR-0008
Alt. D rejected leaking 500 internals: the mismatch is a server-side concern and
may expose field names / internal shape. The drift is logged server-side; the
client receives the handler's data as-is.

## Consequences

### Positive
- Production endpoints survive a benign output drift instead of 500-ing, while
  the mismatch is still logged for follow-up.
- Development and CI keep the loud, fail-fast 500 (`strict` by default).
- `off` is a clean, explicit opt-out for perf-sensitive routes.
- The resolver is a pure function — fully unit-testable without a server — and
  the success path is byte-for-byte unchanged across `strict` / `log`.

### Negative / costs
- In `log` and `off`, the wire body is no longer *runtime-guaranteed* to match
  the declared schema (ADR-0003's runtime arm is relaxed in prod). Mitigations:
  the contract is still declared and still checked in dev/CI; `log` records every
  mismatch; teams that want the guarantee in prod set `outputValidation: 'strict'`.
- One more axis of app configuration. Bounded: a single closed enum with a
  documented default.

### Follow-ups
- A structured "output mismatch" metric/log channel (beyond `console.error`) so
  `log`-mode drift is alertable in production.
- Per-route override (Alternative C) if usage calls for it.
- A `kata verify` rule to flag `outputValidation: 'off'` committed in source, so
  the escape hatch is a deliberate, reviewed choice rather than a silent default.

## Companion rules

This ADR introduces a **runtime configuration value**, not a code-shape pattern,
so it ships no mandatory mechanical lint rule for v0.1. The one rule worth
drafting later (a `kata verify` archgate check) is listed above as a follow-up:

- `kata/no-output-validation-off` — flag a committed `outputValidation: 'off'`
  so disabling validation is always an explicit, reviewed decision.
