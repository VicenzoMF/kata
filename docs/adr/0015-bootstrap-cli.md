# ADR-0015: Bootstrap CLI — `kata init --with-example`

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** @VicenzoMF

## Context

`kata init` today writes only the **harness** configs into an *existing*
project: `.claude/settings.json` (#27, #29), `.codex/hooks.json` (#28), and the
`AGENTS.md` / `CLAUDE.md` instruction pair (#31). It is idempotent — an existing
file is `skipped` unless `--force`, otherwise `created` / `overwritten` — driven
by a single `TARGETS: Target[]` list routed through `writeTarget`, with
`--cwd` / `--force` and a `formatResult` report (`packages/kata/src/cli/`). There
is no command that produces a **runnable** app.

Epic #99 wants "one command that produces a booting app with a basic example
route, so a newcomer goes from zero to `GET /health` in one step." Two sub-issues
hang off the decision recorded here:

- **#101** — implement the runnable scaffold (the bootstrap, in v0.3). It is
  written "Implement the runnable scaffold **per D1**".
- **#102** — `kata new <domain>` per-domain module generator (**D2**),
  deprioritised and explicitly *not* in the v0.3 milestone.

The locked module layout (ADR-0005, AGENTS.md) and the existing `examples/hello`
app fix the conventions a generated app must follow: `src/context.ts`
(`defineContext` + a re-export of `createApp` / `defineRoute`), `src/main.ts`
(`createApp({ modules })` + `serve({ fetch: app.fetch, port })`), and
`src/modules/<domain>/<domain>.{route,schema,…}.ts`.

Forces in play:

- **DX** — a newcomer should reach a live endpoint with the fewest steps and the
  least new vocabulary.
- **Reuse** — `init` already solved created/overwritten/skipped idempotency, path
  handling, and per-file reporting; #100 asks to reuse it rather than re-build it.
- **Verb economy** — the epic *also* wants `kata new <domain>` for module
  generation (#102). Whatever names the bootstrap must not squat on the verb the
  module generator needs.
- **Harness-first** (ADR-0007) — Kata's differentiator is the harness; the
  example should sit *on top of* the harness, not replace or precede it.
- **Safety** — running the bootstrap in a directory that already has source files
  must never clobber them silently.

## Decision

We will **extend `kata init` with a `--with-example` flag** rather than add a
separate `kata new <name>` command. Two decisions are recorded so the epic's
sub-issues have a concrete anchor:

**D1 — Bootstrap command shape: `kata init --with-example`.**
`kata init` keeps writing the four harness files. With `--with-example` it
*additionally* writes the minimal runnable app source files. The example targets
are appended to the same `TARGETS` mechanism and flow through the existing
`writeTarget` → created/overwritten/skipped path; `--cwd` and `--force` apply
unchanged. Without the flag, `kata init` behaves exactly as today (harness only)
— the flag is purely additive.

**D2 — Module generator stays `kata new <domain>` (#102).**
Because the bootstrap reuses the `init` verb, the `new` verb is *reserved* for the
per-domain module generator: `kata new <domain>` emits the five-file module
skeleton into `src/modules/<domain>/`. (Implemented by #102; out of the v0.3
milestone — recorded here only to justify the verb split that D1 enables.)

### Minimal app file set (the locked contract for #101)

With `--with-example`, in addition to the four harness files `init` already
writes, these **source** files are generated, each through the same idempotent
per-file path:

| File | Purpose |
|---|---|
| `src/context.ts` | `defineContext({ … })` + re-export of `createApp` / `defineRoute`; the typed DI surface (ADR-0004). |
| `src/main.ts` | Entry point — `createApp({ modules: [health] })` + `serve({ fetch: app.fetch, port })`. |
| `src/modules/health/health.route.ts` | `defineRoute` for `GET /health`: `input: {}`, `output: HealthSchema`. |
| `src/modules/health/health.schema.ts` | `HealthSchema` Zod DTO (e.g. `z.object({ status: z.literal('ok') })`) — schemas live in `.schema.ts` (ADR-0005). |

This is exactly the set named by #100 / #101. The `health` module is
intentionally **two files** (route + schema) — the smallest unit that passes
`kata verify`: the route declares `input` *and* `output` (ADR-0003), the schema
is not inline (ADR-0005), and the route uses no DI, so the context-key /
scoped-slot / middleware rules are trivially satisfied. No `.service.ts`,
`.test.ts`, or `.hurl` is needed for the route to be valid — those belong to the
richer skeleton emitted by `kata new <domain>` (D2 / #102), not to the
zero-to-running bootstrap.

### Boot-enabling files (`package.json`, `tsconfig.json`)

The four source files are not runnable on their own — `tsx src/main.ts` needs
`kata`, `zod`, `@hono/node-server` (plus `tsx` / `typescript`) and a
`tsconfig.json`. To make the epic's "zero to `GET /health` in one step" literally
true, `--with-example` also emits a minimal `package.json` and `tsconfig.json`
**under the same idempotency rule**: created when absent, **skipped when
present** — so running it inside a project that already has a manifest never
overwrites it. The one unavoidable manual step after scaffolding is installing
dependencies (a CLI cannot ship `node_modules`). #101's "boots via
`tsx src/main.ts`" is then reachable end to end:

```
mkdir my-app && cd my-app
kata init --with-example     # harness + src/ + package.json + tsconfig.json
pnpm install                 # the one manual step
pnpm start                   # tsx src/main.ts → GET /health → 200 {"status":"ok"}
```

### Overwrite / idempotency

No new mechanism. Every example target reuses `writeTarget`: an existing file is
`skipped` unless `--force`, otherwise `created` / `overwritten`. The
`formatResult` report (`create` / `update` / `skip` lines plus the
"re-run with --force" hint) already covers the new files unchanged. This is the
behaviour #100 asked to reuse.

## Alternatives considered

### Alternative A — a distinct `kata new <name>` that scaffolds a fresh project dir
Conventional (`cargo new`, `nest new`, `npm create`). Rejected for three reasons:

1. **Verb collision.** Epic #99 also wants `kata new <domain>` for module
   generation (#102). If `new` means "new project", the module generator needs a
   worse name (`kata generate`, `kata module`) or an overloaded `kata new` that
   disambiguates project-vs-module — both worse than reserving `new` for the
   higher-frequency module command.
2. **Duplicated plumbing.** It would re-implement (or wrap) the
   created/overwritten/skipped reporting, `--cwd`, and `--force` that `init`
   already has — the opposite of what #100 asked.
3. **Two commands that both write harness files.** Users would have to learn when
   to use `init` vs `new`; both scaffold the same `.claude` / `.codex` /
   `AGENTS.md` / `CLAUDE.md`. One command with a flag is a smaller surface.

### Alternative B — a separate `kata example` / `kata scaffold` command (app files only)
Keeps verbs distinct but splits "set up a project" across two commands a
newcomer must run in order (`kata init`, then `kata example`). Rejected: more
steps, and emitting example files *without* the harness contradicts ADR-0007's
harness-first stance. The flag keeps a single "set up my project" entry point.

### Alternative C — `--with-example` writes only the four source files, never `package.json` / `tsconfig.json`
Strictly matches the file list in #100. Rejected as the *whole* behaviour: the
generated app would not boot without the user hand-writing a manifest and a
tsconfig, breaking the epic's "one step" promise and #101's "boots" acceptance.
We keep the four source files as the **locked contract** but *additionally* emit
the manifest / tsconfig idempotently, which costs nothing in an existing project
(they are skipped).

### Alternative D — scaffold a richer example (multiple modules, middleware, tests, hurl), like `examples/hello`
Rejected: the bootstrap's job is the smallest *correct* starting point, not a
tutorial. A larger surface means more for the newcomer to read and more generated
bytes to keep green. The fuller patterns live in `examples/` and in the
`kata new <domain>` skeleton (D2).

## Consequences

### Positive
- One command, one mental model: `kata init` sets up a project; `--with-example`
  chooses harness-only vs harness-plus-runnable-app.
- **Zero new idempotency code** — example targets ride the existing `TARGETS` /
  `writeTarget` / `formatResult` path, so #101 is "add renderers + targets + a
  flag", not "build a second command".
- `kata new <domain>` (#102) keeps the natural verb for the per-domain generator.
- Additive and back-compatible: `kata init` with no flag is byte-for-byte
  unchanged; harness-only users are unaffected.
- Re-runnable in place: `--with-example` fills in only the missing source files
  and never clobbers a real app (skip-on-exists; manifest/tsconfig skip-if-present).

### Negative / costs
- `kata init --with-example` run inside a non-empty, non-Kata project scatters
  `src/` files into it. Mitigated by skip-on-exists, but the files still appear;
  documented as "run in a fresh or Kata-shaped directory".
- Emitting `package.json` / `tsconfig.json` only-if-absent is a small asymmetry
  (they are not in the literal #100 file list). Documented above; the
  alternative (non-booting output) is worse.
- The bootstrap still requires a manual dependency install before first run —
  unavoidable for any scaffolder.
- One more flag on `parseArgs` and a longer `HELP_TEXT`.

### Follow-ups
- **#101** implements D1: pure renderers for the four source files (plus the
  idempotent `package.json` / `tsconfig.json`), wired as example `Target`s behind
  the flag, with tests asserting generated bytes (mirroring `generators.test.ts`).
  Its acceptance — "generated app typechecks, boots, and passes `kata verify`
  clean" — is the mechanical gate on this design.
- **#102** implements D2: the `kata new <domain>` five-file module skeleton
  (route / service / schema / test / hurl).
- Update `HELP_TEXT` in `cli.ts` and the README / cookbook "getting started" to
  show `kata init --with-example`.

## Companion rules

This ADR introduces a **CLI surface**, not a runtime or lint invariant, so it
ships **no new `kata/<rule-id>`** and creates no `0015.rules.ts`. The generated
app is instead held to the *existing* `kata verify` rules (ADR-0003 / 0004 /
0005); #101's acceptance "generated files pass `kata verify` clean" is the
mechanical enforcement that the scaffold stays valid over time.
