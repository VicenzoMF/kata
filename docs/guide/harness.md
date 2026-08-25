---
title: Harness engineering
description: How Kata ships the verifier, the hooks, and the config-tampering guard that make agents produce correct code on the first try.
---

# Harness engineering

A harness is the set of mechanisms around the model — the checks, the hooks, the
locked structure — that catch a mistake the moment it is made and tell the model
how to fix it. Kata's thesis is that this harness is not optional tooling bolted
on later. It is the product. `kata init` ships it into every project.

The governing rule is **less freedom, better output**. A model with infinite
ways to structure a route writes a different structure every time, and you review
every one. A model with exactly one legal structure writes that structure, and a
lint rule rejects anything else before you ever see it. Constraints are not a tax
on the model — they are the thing that makes its output predictable enough to
trust. The same constraints help a human: there is one place a thing can go, so
there is one place to look.

This page describes the three feedback layers Kata wires up, why they are fast,
and what `kata init` writes to turn them on.

## Three feedback layers

The harness runs the same project through three loops at three speeds. Each layer
fails closed — a red check blocks rather than warns.

| Layer | Trigger | Command | Speed |
|---|---|---|---|
| `PreToolUse` | before a file write | `kata verify --json` + deny rules | <100ms |
| `PostToolUse` | after a file write | `kata verify --json` | <100ms |
| `Stop` | before the agent declares done | `pnpm test` | seconds |

The millisecond layers (`PreToolUse` / `PostToolUse`) run on every edit, so they
must be fast enough to never interrupt the model's flow. The `Stop` gate runs the
real test suite once, when the agent thinks it is finished: `kata verify` is a
lint engine, not a test runner, so "done" is gated on the actual tests.

## `kata verify` in a PostToolUse hook

After the agent writes a file, `PostToolUse` runs `kata verify --json`. The
command reads the project, runs the deterministic rules, and prints a single JSON
object on stdout — the shape a Claude Code `PostToolUse` hook consumes.

On a clean run the output is the empty object, a no-op hook result:

```json
{}
```

On a violation the hook emits `decision: "block"` and injects the full report as
`hookSpecificOutput.additionalContext`, so the agent is *told to fix* the issue
on its next turn, not merely shown it:

```json
{
  "decision": "block",
  "reason": "kata verify found 1 violation.",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "kata verify found 1 violation. Fix it before continuing:\n\nERROR: ..."
  }
}
```

::: info Why `--json` always exits 0
In `--json` mode `kata verify` always exits 0. The decision rides inside the
payload; a non-zero exit would make the harness surface stderr instead of the
JSON, and the agent would never see the structured feedback.
:::

### ERROR / WHY / FIX / EXAMPLE

Every issue inside `additionalContext` renders with the same four-part template.
This is the format that drives a correct fix instead of a guess: it states what
is wrong, why the rule exists (with the ADR that decided it), the concrete
remediation, and a bad/good code pair.

```
ERROR: route "createUser" is missing an output schema
  src/modules/users/users.route.ts:12:3  [kata/no-route-without-output-schema]

  WHY: every route declares input and output schemas so the contract is
  verifiable and the RPC client can infer types (ADR-0003).

  FIX: add an `output` schema to the defineRoute call.

  EXAMPLE:
    // Bad:
    defineRoute({ method: 'POST', path: '/users', input: { body: B }, handler })
    // Good:
    defineRoute({ method: 'POST', path: '/users', input: { body: B }, output: UserSchema, handler })
```

The same renderer feeds the human terminal report (`kata verify` without
`--json`), so the agent and the developer read the identical text.

The rules `kata verify` enforces, each anchored to the ADR that justifies it:

| Rule | Checks | ADR |
|---|---|---|
| `kata/no-route-without-output-schema` | every `defineRoute` declares `output` | ADR-0003 |
| `kata/no-route-without-input-schema` | every `defineRoute` declares `input` | ADR-0003 |
| `kata/inline-schema` | Zod schemas live in `*.schema.ts` | ADR-0005 |
| `kata/context-key-not-registered` | `c.get('key')` is a registered context key | ADR-0004 |
| `kata/scoped-slot-not-provided` | a scoped `c.get` has a providing middleware *earlier in the chain* — in the route's `use:` or in `createApp({ middlewares })` | ADR-0004 |
| `kata/scoped-read-outside-request` | a scoped `c.get` is read only inside a request handler | ADR-0004 |
| `kata/middleware-provides-mismatch` | `provides[]` matches the handler's `c.set` (warns when a `c.set` slot is omitted from `provides`) | ADR-0004 |
| `kata/jwt-auth-provides-slot` | a `jwtAuth({ slot })` middleware declares `provides: [slot]` | ADR-0013 |
| `kata/no-adhoc-error-shape` | errors use `c.error(...)`, not inline `c.json({ error }, 4xx/5xx)` | ADR-0008 |
| `kata/no-raw-boundary-cast` | `as never` boundary casts are contained to `hono-bridge.ts`; a raw `as unknown` cast elsewhere carries a `// kata-allow: hono-boundary` marker | ADR-0025 |
| `kata/schema-file-naming` | files in a module are named `<domain>.{route,service,schema}.ts` | ADR-0018 |
| `kata/no-decorator` | no `@decorator` syntax under `src/` | ADR-0002 |
| `kata/no-class` | no `class` declarations under `src/` | ADR-0002 |

See [Bootstrap CLI](/guide/cli) for the full command surface, including
`kata verify --watch` for a re-checking terminal loop.

## When a rule cannot prove a check

Every rule reads source, never types or runtime values. Some expressions are
therefore unreadable to it — a middleware assembled at runtime, one imported from
a package whose source it cannot see, a `...spread` that could contribute
anything. A rule facing one of those has three options, and only one of them is
honest:

1. flag it anyway → false positives, which train you to ignore the tool;
2. skip it silently → a green checkmark that asserts something nobody proved;
3. **say what it could not check.**

Kata takes the third. The unchecked case is reported as a **suppression**: the
rule, the reason, the exact location, and how many checks it swallowed.

```
✓ kata verify: no problems found (13 files checked)

⚠ 1 check suppressed — a rule could not prove its property here:
  kata/scoped-slot-not-provided: suppressed for 3 checks — could not resolve `authFactory()` in createApp({ middlewares })
    src/app.ts:17:18

A suppressed rule is not a passing rule. Re-run with --strict-coverage to fail on these.
```

Suppressions ride in the `--json` payload too, under a `suppressions` array and in
the injected context, so an agent sees the gap instead of reading a clean report.
They do not block on their own — the code may be perfectly correct — but
`kata verify --strict-coverage` exits non-zero on any of them. The generated
`lefthook.yml` uses that flag, so a chain that becomes unverifiable fails the
commit rather than quietly reducing coverage.

Closing a suppression means making the expression readable:

- **A middleware from an npm package.** The package ships a `provides.json`
  manifest describing what each exported middleware provides and reads; `@katajs-framework/core`
  generates its own at build time, which is why `cors()`, `secureHeaders()` and
  `bodyLimit()` resolve. Third-party middleware authors can ship the same file.
- **A local factory.** `kata verify` follows a call to its `return`, so
  `requireRole('admin')` resolves as long as the factory returns a
  `defineMiddleware({ ... })` (or a middleware literal) it can read.
- **A spread or a computed list.** Write the array literally. `use: [a, b]` is
  checkable; `use: [...preset]` is not.

## Why the harness is fast

A linter that needs a type-checker or a bundler to answer a question cannot run on
every keystroke. `kata verify` answers in under 100ms because Kata's three
invariants make every check a local, syntactic question — no type inference, no
cross-file graph to resolve at lint time.

1. **Static DI.** Every dependency is declared in one `defineContext({...})`.
   Verifying that `c.get('key')` is legal is a set-membership test against the
   keys parsed from `src/context.ts` — not a walk of the type graph.
2. **Mandatory schemas.** Every route declares `input` and `output`. Checking
   that a schema is present is reading the `defineRoute` object literal, not
   evaluating it.
3. **Locked folder layout.**
   `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts` means every
   route, schema, and test is findable by glob. The verifier knows where to look
   without resolving imports.

Because the rules are pure functions over parsed files, they are also trivially
unit-tested and carry a zero false-positive bias: when the registry cannot be
determined, the dependent rules no-op rather than guess.

## Non-goals: what `kata verify` deliberately does not check

Not every property worth checking becomes a rule. One came up in review
([issue #251](https://github.com/VicenzoMF/kata/issues/251)): a module under
`src/modules/<domain>/` whose routes are never passed into any
`createApp({ modules })` is dead surface — every route inside it still passes
`kata/no-route-without-output-schema` and friends individually, because those
rules scan `*.route.ts` files directly (see the table above) and never ask
whether the module reached an app. Should an "orphan module" be its own rule?

**Decided: a documented non-goal, not a rule.**

Every rule above proves a *presence* — a `c.get('key')` that exists and is
unregistered, a `class` that exists, an inline `z.object(...)` that exists.
The unreadable case (a spread, a value computed at runtime) is safe to skip,
because skipping only forgoes the check on that one expression; the "no
cross-file graph to resolve at lint time" invariant above holds because each
rule's answer stays local to what it can read.

An orphan-module rule would prove an *absence*: that no `createApp({ modules })`
anywhere in the project ever includes this module. That is not a local
question:

- A project can have more than one `createApp` call — separate servers, a
  worker, example apps each wiring a different subset. "Reachable" has to be a
  union over every call site the project has, not one.
- `modules:` is exactly the shape `kata verify` already treats as unresolvable
  when it shows up in `middlewares:` / `use:` — built from a shared list,
  filtered by an env flag, assembled in a test harness. Every other rule
  answers an unresolved expression with "skip it," and that costs one
  unchecked call site. Here it costs the one piece of evidence that would have
  cleared the module: the moment a project uses one indirection, a
  correctly-wired module starts reading as orphaned. The failure mode this
  rule exists to avoid is exactly the one it would introduce.
- Nothing mandates it. `createApp({ modules })` taking a hand-picked subset is
  the working shape — a module scaffolded ahead of being wired in, one built
  for a deployment the current app isn't — so there is no ADR to anchor a rule
  to, unlike every rule in the table above. The rule-set epic
  ([#164](https://github.com/VicenzoMF/kata/issues/164)) scoped itself to
  mechanically enforcing ADRs already on the books and has already shipped its
  full scope (6/6 sub-issues); orphan-module detection was never part of it.

Reachability across an arbitrary number of entry points is a whole-program
question — the kind a dedicated dead-code tool (`ts-prune`, `knip`) answers
with full type information, not a sub-100ms syntactic pass over one file at a
time. If that becomes worth having, it is a separate tool wired into CI, not a
`kata verify` rule.

## The config-tampering guard

The harness-engineering literature names two reflexes a model reaches for the
moment a check goes red — both turn a failing signal green without touching the
code that failed:

1. **Bypass the commit gate** — `git commit --no-verify` (or `-n`),
   `git push --no-verify`, a `SKIP=<hook>` env prefix.
2. **Edit the rule itself** — delete an Oxlint rule, widen `tsconfig.json`, blank
   a CI workflow, rewrite a hook script. The check passes because the check is
   gone.

[ADR-0010](/adr/0010-ban-no-verify-and-config-tampering) bans both, mechanically
and identically across every harness. This is a single source of truth: the
banned commands and the protected file set are declared once and reproduced in
every project `kata init` scaffolds.

### No `--no-verify`

The verification bypasses are denied outright. In a generated project they live
in `.claude/settings.json` under `permissions.deny`:

```json
{
  "permissions": {
    "deny": [
      "Bash(git commit *--no-verify*)",
      "Bash(git commit *-n *)",
      "Bash(git push *--no-verify*)",
      "Bash(SKIP=*)"
    ]
  }
}
```

Codex has no `permissions.deny` slot, so its `PreToolUse` hook enforces the same
command bans — parity by construction, not by copy.

### The protected config set

The same ADR protects the lint / format / build / framework configs and the
harness's own files from agent writes:

```
tsconfig.json   tsconfig.*.json   biome.json   .oxlintrc*   lefthook.yml
kata.config.ts  pnpm-lock.yaml    pnpm-workspace.yaml       .github/workflows/**
.claude/settings.json             .codex/hooks.json
```

In Claude Code these become per-tool `permissions.deny` rules (one for each of
`Edit`, `Write`, `MultiEdit`), so a freshly scaffolded project is protected from
its first session — before any `kata verify` ruleset is even built. The
`PreToolUse` hook is the second layer: it carries the ADR-anchored explanation
and is where Codex (no deny slot) enforces the identical set.

::: warning Humans still edit these files
The bias is *always block in the agent flow*. There is no reliable in-hook
human/agent discriminator, and Kata does not try to build one. When you need to
change a protected config, do it from a non-agent shell.
:::

::: tip Self-applied first
Kata applies this harness to its own repo. [ADR-0007](/adr/0007-self-apply-harness-before-feature-work)
made a self-applied harness milestone block all feature work: the framework is
its own first user, so the harness `kata init` ships is the one that built Kata.
:::

## What `kata init` wires up

`kata init` writes the harness into a project. It is idempotent — an existing file
is left untouched unless you pass `--force`.

```bash
kata init
```

It writes six files:

```
.claude/settings.json    Claude Code hooks + config-tampering bans
.codex/hooks.json        Codex hooks → kata verify --json
.agents/hooks.json       Vendor-neutral mirror of the same hook chain
AGENTS.md                Canonical agent instructions (Codex + Claude)
CLAUDE.md                Claude entrypoint → imports AGENTS.md
lefthook.yml             Local git pre-commit: kata verify, Biome, oxlint, typecheck
```

The generated `.claude/settings.json` carries the `permissions.deny` lists above
plus the three-event hook map: `PreToolUse` and `PostToolUse` matched on
`Write|Edit|MultiEdit` run `kata verify --json`; `Stop` runs `pnpm test` with a
180-second timeout.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "kata verify --json" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "kata verify --json" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "pnpm test", "timeout": 180 }] }
    ]
  }
}
```

`.codex/hooks.json` is the same hook map with one difference: the matcher is
`Bash|apply_patch`. Codex matches on tool names and has no `Write`/`Edit`/
`MultiEdit` tools, so file writes are detected from the `Bash`/`apply_patch` tool
instead. The commands, the events, and the `Stop` timeout are identical — that
parity is the point. `.agents/hooks.json` is a byte-for-byte-equivalent third
mirror, for any harness that reads the emerging vendor-neutral `.agents/`
convention instead of `.claude/` or `.codex/`.

`kata init` scaffolds a complete runnable app on top of these harness files by
default; `--minimal` writes only the harness. See [Bootstrap CLI](/guide/cli) for
every flag.

## Running `.hurl` in CI

The `Stop` layer in the table above runs `pnpm test` — Vitest only. The `.hurl`
suites each module ships (see [project layout](/guide/project-layout)) are a
separate, fourth layer that the harness does not wire up on its own, because
they need something the other three layers don't: a live server. `pnpm hurl`
against a server nobody started just fails with a connection error, so the
suite is easy to leave outside every automated gate — validated by hand once
and never run again.

Kata's own CI closes that gap for the framework's example apps, and the same
shape works for a generated app: **start the server, wait for it to accept
connections, run Hurl, tear the server down.** This is the real job from
[`.github/workflows/ci.yml`](https://github.com/VicenzoMF/kata/blob/main/.github/workflows/ci.yml),
which boots `examples/hello` and `examples/shop` on separate ports and runs
both suites against them:

```yaml
- name: Install hurl
  run: |
    curl -fsSL -o /tmp/hurl.deb \
      "https://github.com/Orange-OpenSource/hurl/releases/download/${HURL_VERSION}/hurl_${HURL_VERSION}_amd64.deb"
    sudo dpkg -i /tmp/hurl.deb

- name: Run hurl E2E (hello + shop)
  run: |
    pnpm --filter=hello start &
    HELLO_PID=$!
    PORT=3001 pnpm --filter=shop start &
    SHOP_PID=$!
    trap 'kill "$HELLO_PID" "$SHOP_PID" 2>/dev/null || true' EXIT
    npx --yes wait-on tcp:3000 tcp:3001 --timeout 30000
    pnpm --filter=hello hurl
    pnpm --filter=shop run hurl --variable host=http://localhost:3001
```

A generated app has one server, not two, so the recipe collapses to four
lines — this is exactly what the scaffolded `README.md` documents under
"Continuous integration":

```bash
pnpm start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
npx --yes wait-on tcp:3000 --timeout 30000
pnpm hurl
```

Nothing here is GitHub-Actions-specific — it is four shell lines, so the same
block works as a step in any CI, or as a local pre-push script. `wait-on`
(fetched ad hoc with `npx --yes`, no dependency to add) polls the port instead
of a fixed `sleep`, so the job runs as soon as the server is actually ready
and never races a slow boot. The `trap` guarantees the server dies whether the
suite passes or fails — a failing request fails the step (and therefore the
job) without leaking a process behind it.

## See also

- [Bootstrap CLI](/guide/cli) — the full `kata` command surface.
- [ADR-0007](/adr/0007-self-apply-harness-before-feature-work) — self-apply the harness before feature work.
- [ADR-0010](/adr/0010-ban-no-verify-and-config-tampering) — ban `--no-verify` and config tampering.
