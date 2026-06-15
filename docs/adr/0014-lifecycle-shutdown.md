# ADR-0014: Lifecycle teardown — `onClose` callback + Node signal/drain contract

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** @VicenzoMF

## Context

A long-lived Kata process holds resources that must be released in an orderly
way when the orchestrator asks it to stop: a database pool to drain, a queue
consumer to stop, buffered logs or metrics to flush. Today none of that is
handled. There is no `SIGTERM` trap, and singletons have no teardown hook — so
`docs/cookbook/database.md` punts explicitly:

> **Lifecycle is outside the request.** Closing the pool on shutdown belongs in
> the server bootstrap (`main.ts`) via process signals — Kata has no per-request
> teardown hook for singletons.

`docs/cookbook/migrating-from-nestjs.md` carries the same gap as a migration
note: NestJS's `OnApplicationShutdown` has no Kata equivalent, and the table
sends the reader to "shutdown via process signals in `main.ts`". An app that
ignores `SIGTERM` is killed mid-flight: in-flight requests are dropped and the
pool never closes, so the next deploy or pod-rotation truncates live work.

This is the *always-the-same plumbing* epic #95 describes — trap the signal,
stop accepting connections, run user teardown, force-exit on a timeout. Getting
it right (correct drain order, an escape hatch when a connection hangs, no
listener leaks) is fiddly and identical across every app, which is exactly the
kind of thing a framework should own. **This ADR decides the contract; it ships
no code.** The helper itself is #97 and the worked example/doc updates are #98.

The forces in play:

- **Who owns teardown order?** Resource shutdown is the *inverse* of construction
  order and is domain-specific (flush metrics, then drain the queue, then close
  the pool). The framework does not know that order; the app does.
- **Where does the framework stop and `main.ts` begin?** ADR-0004 made singletons
  *eager* — `makeDb(env)` runs when `context.ts` is imported. Construction has a
  natural order (module evaluation, dependencies passed as arguments); teardown
  does not, and it must also wait for in-flight requests first.
- **Runtime neutrality.** ADR-0001 chose Hono for first-class edge/Workers/Deno
  support and deliberately rejected a plugin *lifecycle* model. Signal handling
  is a Node concept (`process.on('SIGTERM')`); Workers have no long-lived process
  to signal. Whatever we add must not drag `node:process` into the runtime-neutral
  core.
- **Scope.** v0.3 targets the `@hono/node-server` adapter only (epic #95);
  edge/Bun/Deno lifecycle belongs to the v0.4 cross-runtime milestone.

## Decision

We will keep teardown a **single `onClose` callback wired by the app in
`main.ts`**, and have Kata own only the always-identical Node plumbing through a
helper:

```ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'kata/node'

const server = serve({ fetch: app.fetch, port })

gracefulShutdown(server, {
  onClose: async () => {
    // App-owned teardown, in the app's chosen order. Resources are reached
    // through the registry (ADR-0004) or closed-over references.
    await k.registry.db.__value.close()
  },
  signals: ['SIGTERM', 'SIGINT'], // default
  timeoutMs: 10_000,              // default
})
```

```ts
type GracefulShutdownOptions = {
  onClose: () => void | Promise<void>
  signals?: readonly NodeJS.Signals[] // default ['SIGTERM', 'SIGINT']
  timeoutMs?: number                   // default 10_000
}

function gracefulShutdown(server: ServerType, options: GracefulShutdownOptions): void
```

`ServerType` is the handle `@hono/node-server`'s `serve()` returns (a
`node:http`/`http2` `Server`). The helper takes the **server**, not the Kata
`app` — the app is the request handler; the server is the thing that owns the
listening socket and in-flight connections.

### Teardown model: callback, not an auto-dispose registry

Kata does **not** own a teardown registry. We rejected attaching an optional
`dispose()` to singleton slots (`singleton(value, { dispose })`) that the
framework auto-runs on shutdown. Rationale:

1. **Teardown order is the inverse of construction order, and only the app knows
   it.** A registry would have to invent an ordering policy (reverse-registration?
   reverse-dependency?) and would get it wrong for any non-trivial graph. A single
   `onClose` lets the app sequence teardown explicitly — the same principle
   ADR-0004 chose for middleware ("the order in the `use:` array is the contract":
   explicit ordering over implicit resolution).
2. **Lifecycle is a property of a few resources, not of the slot mechanism.**
   Most singletons — a logger, a config object, a table of pure functions — have
   nothing to close. Putting `dispose` on `singleton()` spreads a teardown concern
   across every registration when only one or two slots ever need it, and invites
   a `dispose` on things that should not have one.
3. **It keeps the framework-vs-BYO line where epic #95 drew it.** Kata owns the
   plumbing that is genuinely hard and identical everywhere (trap once, stop
   accepting, await drain, force-exit). *What* to close, and *in what order*, is
   domain knowledge that stays in `main.ts`. An auto-dispose registry drags that
   knowledge into the framework.
4. **Partial-failure policy stays in app code.** If closing one resource throws,
   the app decides whether to continue, abort, or log — with an ordinary
   `try/catch` inside `onClose`. Kata does not have to standardise a
   teardown-error policy for everyone.
5. **It is the smaller, non-breaking surface, and forecloses nothing.** A future
   `singleton(value, { dispose })` could be implemented purely as a built-in
   `onClose` that walks the registry in reverse — additive on top of this
   contract, exactly as ADR-0011 widened `output` without breaking the single-schema
   form. Choosing the callback now keeps that door open (see Follow-ups).

### Signals and the framework / `main.ts` boundary

- **Signals trapped:** `SIGTERM` (the orchestrator's graceful-stop signal —
  `docker stop`, Kubernetes pod termination, systemd) and `SIGINT` (Ctrl-C in a
  dev terminal, so local shutdown drains too). Default `['SIGTERM', 'SIGINT']`,
  overridable via `signals`. `SIGKILL`/`SIGSTOP` are uncatchable by definition and
  `SIGHUP` (reload semantics vary by deployment) is intentionally left to the app.
- **The framework provides the helper; `main.ts` calls it.** Kata does **not**
  install signal handlers as a side effect of `createApp`. Building an app must
  not have the global side effect of registering `process.on` listeners — that is
  surprising, leaks duplicate listeners across multiple apps and across test runs,
  couples the runtime-neutral core to `node:process`, and is wrong for serverless
  or embedded callers that never own the process. Opting in from `main.ts` (the
  one place ADR's layout already lets talk to `process`) is the boundary.

### Drain semantics

On the **first** trapped signal, `gracefulShutdown` runs, in order:

1. **Guard against re-entry.** A second `SIGTERM`/`SIGINT` while already shutting
   down is ignored — the helper is idempotent and double-signal safe (#97).
2. **Arm the force-exit timer.** `setTimeout(() => process.exit(1), timeoutMs)`,
   `.unref()`'d so the timer itself never keeps the event loop alive.
3. **Stop accepting new connections.** `server.close()` — Node stops the listener
   and closes idle keep-alive sockets; **in-flight requests run to completion**.
4. **Await the in-flight drain** — the `server.close(callback)` completion, which
   fires once every open connection has finished.
5. **Run `await onClose()`** — *after* the drain, so no in-flight handler loses
   its pool or transaction mid-query. (Closing resources concurrently with the
   drain would break requests still using them; sequential drain → `onClose` is
   the safe default.)
6. **Exit `0`.** Clean shutdown completed within the budget.

If steps 4–5 exceed `timeoutMs`, the timer fires first and the process force-exits
with a **non-zero** code (in-flight work was abandoned — a distinct, visible
outcome for the orchestrator, not a clean stop). `timeoutMs` defaults to
**10 s** and **must be set below the orchestrator's grace period** (Kubernetes'
`terminationGracePeriodSeconds` defaults to 30 s, after which it sends an
uncatchable `SIGKILL`): the in-process timer is the *soft* deadline that still
lets us exit cleanly; the orchestrator's is the *hard* one we want to beat.

The shutdown routine must be invokable directly in a unit test (no real signal
required) so #97 can cover the signal → `onClose` → timeout path deterministically.

### Adapter scope

Node (`@hono/node-server`) only, shipped as a **new `kata/node` subpath export**.
Keeping the Node-only helper (and its `node:process` / `ServerType` dependencies)
out of the package root preserves the root entry's runtime neutrality (ADR-0001):
an edge/Workers build importing `kata` never pulls in `node:process`. Edge, Bun,
and Deno have different lifecycle models (Workers have no process signal; Bun and
Deno expose signals but differ on server-close semantics) and are deferred to the
v0.4 cross-runtime milestone.

## Alternatives considered

### Alternative A — auto-run dispose registry (`singleton(v, { dispose })`)
Attach an optional `dispose()` to singleton slots and have the framework iterate
them on shutdown. Rejected for the five reasons in *Teardown model* above —
chiefly that teardown ordering is domain knowledge the framework cannot infer,
and that lifecycle is a property of a few resources, not of every slot. It remains
a viable **future additive layer** built on top of `onClose` (Follow-ups) if real
usage shows the open/close co-location DX is worth it; choosing the callback now
does not foreclose it.

### Alternative B — auto-install signal handlers inside `createApp`
Have `createApp` register `process.on('SIGTERM', …)` itself, so shutdown "just
works". Rejected: constructing an app should be free of global process side
effects. It leaks duplicate listeners when a test (or a process) builds more than
one app, couples the runtime-neutral core to `node:process` (breaking the ADR-0001
edge story), and assumes the caller owns the process — false for serverless,
embedded, or test hosts. The signal trap is opt-in from `main.ts`.

### Alternative C — `createApp` returns a `dispose()` method
Make `createApp` return `{ fetch, dispose }` and have the app expose teardown.
Rejected: `createApp` returns the RPC-typed Hono app (`KataApp`, ADR-0011 / epic
#11); bolting a `dispose` onto that value muddies the type that the RPC client
infers from, and it still solves neither signal trapping nor draining. The object
you must `close()` to stop accepting connections is the **server**, not the app —
`gracefulShutdown(server, …)` takes the right handle.

### Alternative D — a full lifecycle / plugin system (`onStart`/`onClose`/`onError`)
Adopt a Fastify-style lifecycle with ordered hooks. Rejected: ADR-0001 explicitly
declined a plugin lifecycle model, and v0.3 needs only teardown. A hook framework
is far more surface than the problem warrants and can be revisited if a concrete
need beyond teardown appears.

## Consequences

### Positive
- The error-prone, always-identical plumbing (signal trap, connection drain,
  force-exit timer, idempotency) is owned and tested once by the framework (#97),
  not re-derived — usually subtly wrong — in every app's `main.ts`.
- The teardown contract is tiny and explicit; `onClose` ordering belongs to the
  app, matching ADR-0004's explicit-ordering ethos.
- The package root stays runtime-neutral (ADR-0001): Node-only lifecycle lives
  behind `kata/node`, so edge/Workers builds never import `node:process`.
- Non-breaking and additive — a dispose-registry (Alternative A) can be layered on
  later without changing this contract.
- Closes the standing punt in `docs/cookbook/database.md` and the
  `OnApplicationShutdown` gap in `docs/cookbook/migrating-from-nestjs.md`:
  pool-closing on shutdown finally has a blessed, copy-pasteable pattern (#98).

### Negative / costs
- **No framework guarantee that every resource is closed.** A resource the app
  forgets to close in `onClose` leaks on shutdown — the cost of not owning a
  registry. Mitigated by the cookbook recipe and the worked example (#98), and by
  `gracefulShutdown` reducing the wiring to a few lines.
- **Open and close live in two places** — the `singleton(makeX(env))` factory in
  `context.ts` and the matching close in `main.ts`'s `onClose` — rather than
  co-located. Accepted in exchange for explicit teardown ordering.
- **Node-only for v0.3.** Edge/Bun/Deno users get no helper yet (explicit v0.4
  scope).
- **A new `kata/node` subpath export** to maintain in `packages/kata/package.json`.

### Follow-ups
- **#97** — implement `gracefulShutdown(server, { onClose, signals?, timeoutMs? })`
  for the Node adapter: registers handlers, stops accepting, awaits the drain then
  `onClose`, force-exits after `timeoutMs`; idempotent (double-signal safe); no
  `any`; a unit test simulating the signal → `onClose` → timeout path.
- **#97** — add the `kata/node` subpath export (Node-only entry) to the package.
- **#98** — ship an example `main.ts` closing a stub DB pool on `SIGTERM`, and
  update `docs/cookbook/database.md`'s lifecycle gotcha and the
  `docs/cookbook/migrating-from-nestjs.md` `OnApplicationShutdown` row to point at
  the pattern.
- **v0.4 cross-runtime milestone** — edge/Bun/Deno lifecycle adapters (ties into
  ADR-0001's multi-runtime stance).
- **Possible additive `singleton(value, { dispose })`** (Alternative A) layered on
  `onClose`, if usage shows the co-location DX earns its keep.

## Companion rules

This ADR decides a **runtime contract and a packaging boundary**; like ADR-0011 it
introduces **no new mandatory mechanical rule** for v0.3. There is no multi-file
source invariant to grep for — `gracefulShutdown` is opt-in library code, not a
shape every module must follow.

Rule IDs worth drafting later, once the helper ships (#97), are speculative and
listed here rather than enforced now:

- `kata/raw-signal-handler` (future) — flag a hand-rolled
  `process.on('SIGTERM' | 'SIGINT', …)` in app code and nudge it toward
  `gracefulShutdown`, which gets drain ordering and the force-exit timer right.
