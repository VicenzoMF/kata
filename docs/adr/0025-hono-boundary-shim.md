# ADR-0025: Hono Boundary Shim (supersedes ADR-0019)

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Agent

## Context

ADR-0019 chose to keep the Hono-boundary `as never` / `as unknown` casts
inline, at each call site in `context.ts`, guarded by a `// kata-allow:
hono-boundary` marker comment and a `kata/no-raw-boundary-cast` verify rule
that enforces the marker's presence. It considered and rejected a single
`hono-bridge.ts` shim, reasoning that centralizing the casts would add
indirection for little benefit, since `context.ts` was "effectively the
bridge already."

Two things ADR-0019 didn't have in front of it:

1. **The pattern already leaked outside `context.ts`.** `jwt/index.ts`'s
   `jwtAuth` and `guard` independently reinvented the same cast — not even
   `as never` on the key, but `(c.set as unknown as (key, value) => void)(...)`,
   a differently-shaped escape hatch solving the same problem (a runtime
   string key the type system can't prove belongs to the map it's read
   from/written to). The marker mechanism caught it (both sites carry `//
   kata-allow: hono-boundary`), but "carries a comment" is a much weaker
   guarantee than "cannot exist outside one file" — exactly the failure mode
   ADR-0019's own Alternative B (status quo, no rule at all) was rejected
   for anticipating, just one layer further out than that alternative
   considered.
2. **The performance question was open.** This exact hot path
   (`context.ts`'s `get`/`set`/`json`) was rewritten twice on 2026-08-25
   (issue #163: prototype-based context objects; a same-day follow-up:
   dropping `bind()`/`Object.assign` from the dispatch path after
   benchmarking showed they cost 65–100% and ~2x per call respectively). A
   shim wrapping every boundary call in an extra function frame is a
   reasonable thing to worry about on a path this recently and deliberately
   tuned.

## Decision

We adopt ADR-0019's rejected Alternative A: a single `packages/kata/src/hono-bridge.ts`
module exporting `typedGet`, `typedSet`, `typedJson` — the only place in the
package a raw `as never` cast may appear. `kata/no-raw-boundary-cast` is
rewritten accordingly:

- `as never` outside `hono-bridge.ts` is now a hard error, unconditionally —
  no marker can excuse it. It must be a call to `typedGet`/`typedSet`/`typedJson`.
- `as never` inside `hono-bridge.ts` still requires the `// kata-allow:
  hono-boundary` marker (documentation, not a loophole — there's exactly one
  file's worth to mark).
- `as unknown` is unchanged from ADR-0019: marker-gated, anywhere. It still
  covers the casts that are not this get/set/json boundary at all — DI slot
  branding (`singleton`/`scoped`), `defineContext`'s covariant `createApp`
  return, `registerRoute`'s dynamic `app[method]` dispatch, and JWT claims
  narrowing (`claims as unknown as Record<string, unknown>`) — all left
  exactly where ADR-0019 put them; this ADR does not revisit that half of
  the rule.

`typedGet` / `typedSet` are typed against a minimal structural shape
(`{ get(key: never): unknown }` / `{ set(key: never, value: never): void }`)
rather than hardcoded to Hono's `Context`, because the leaked pattern in
`jwt/index.ts` needed to cross the *same* wall from a different type: Kata's
own `MiddlewareContext<R>`, whose `get`/`set` are strictly keyed to a
registry `R` that's still an opaque generic parameter inside `guard()` /
`jwtAuth()`. One shim now serves both the raw-Hono boundary (`context.ts`)
and the opaque-generic-registry boundary (`jwt/index.ts`), because they are
the identical problem — a compile-time-unprovable key — wearing two
different call shapes.

### Performance

Measured with an interleaved micro-benchmark (direct `c.get(key as never)`
vs `typedGet(c, key)`, alternating which runs first each round to cancel out
system noise, against a real captured Hono `Context`, warmed up before
measurement): 500,000 iterations × 11 rounds for the get/set roundtrip,
20,000 × 11 for the json response (smaller — unread `Response` bodies
otherwise exhaust the heap before GC catches up).

| Pattern | Direct (median) | Wrapped (median) | Delta |
|---|---|---|---|
| get/set roundtrip | ~14.9ns/op | ~13.9–15.3ns/op | −6.7% to +4.6% across runs |
| json response | ~8240ns/op | ~7960–8200ns/op | −3.4% to −0.3% across runs |

The delta's sign flips between runs and stays within single digits of zero
in both directions — indistinguishable from measurement noise, not a real
effect. This matches the theoretical expectation: `typedGet`/`typedSet`/
`typedJson` are small, monomorphic, non-allocating pass-through functions,
which V8/TurboFan inline after JIT warm-up, eliminating the extra call frame
in steady state. This is categorically different from the `bind()`/
`Object.assign` cost the same-day dispatch-path commit measured and fixed —
those allocate (a bound-function object, a copied intermediate object) on
every call; `typedGet`/`typedSet`/`typedJson` allocate nothing.
An end-to-end `app.fetch()` benchmark was tried first and discarded: on this
machine it swings ~80% run-to-run from unrelated system noise, which buries
a signal this small entirely.

## Alternatives considered

Re-litigated from ADR-0019, given the new evidence above:

### Alternative A (this ADR) — the shim, as ADR-0019's rejected alternative
Adopted. See Decision.

### Alternative B — keep ADR-0019's inline-marker pattern, extend the marker convention to jwt/index.ts's shape
Formalize a second marker variant for the "opaque generic registry" cast
shape jwt/index.ts uses, instead of building a shim. *Why rejected:* doesn't
address the actual gap — the marker only proves a comment exists next to a
cast, not that the cast is correct or that a THIRD shape doesn't show up in
a fourth file next month. The containment property (mechanically provable:
grep `as never` outside one file, get zero) is what the shim buys and the
marker cannot.

### Alternative C — shim only the raw-Hono boundary; leave jwt/index.ts's casts inline with markers
Narrower shim, `context.ts` only. *Why rejected:* leaves exactly the leak
that motivated revisiting ADR-0019 in the first place unaddressed, and
`typedGet`/`typedSet`'s structural typing turned out to cover both shapes
for free — there's no real cost to including jwt/index.ts.

## Consequences

### Positive
- `kata/no-raw-boundary-cast` now makes a structural claim
  ("`as never` cannot exist outside this one file") instead of a
  documentation claim ("this cast has a comment near it") — strictly
  stronger, and mechanically simpler to state and verify.
- `jwt/index.ts`'s two ADR-0013 boundary casts are typed the same way as
  `context.ts`'s, instead of an independently-invented variant.
- Measured, not assumed, performance-neutral on the exact path the same-day
  #163 refactor was tuning.

### Negative / costs
- One more file, three more exported functions, for what ADR-0019 called
  "unnecessary cognitive overhead." The measured neutral performance and the
  closed leak are judged worth it.
- `Gettable`/`Settable`'s structural typing (`key: never`) is slightly
  looser than a signature naming Hono's `Context` outright — by design, so
  the same shim serves `MiddlewareContext<R>` too, but it means a future
  third `get`/`set`-shaped type would also silently qualify, unchecked
  beyond "has a method named get/set."

### Follow-ups
- None — `kata/no-raw-boundary-cast` and `hono-bridge.ts` ship together in
  the same change as this ADR.

## Companion rules

Mechanical enforcement of this ADR lives in `no-raw-boundary-cast.ts`
(archgate pattern) — the same rule ADR-0019 introduced, rewritten in place
rather than replaced, since it is still the single rule governing this
boundary.

- `kata/no-raw-boundary-cast` — `as never` is disallowed outside
  `hono-bridge.ts`; `as unknown` (anywhere, including inside
  `hono-bridge.ts`) requires a `// kata-allow: hono-boundary` marker.
