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
| `kata/scoped-slot-not-provided` | a scoped `c.get` has a providing middleware | ADR-0004 |
| `kata/scoped-read-outside-request` | a scoped `c.get` is read only inside a request handler | ADR-0004 |
| `kata/middleware-provides-mismatch` | `provides[]` matches the handler's `c.set` (warns when a `c.set` slot is omitted from `provides`) | ADR-0004 |
| `kata/jwt-auth-provides-slot` | a `jwtAuth({ slot })` middleware declares `provides: [slot]` | ADR-0013 |
| `kata/no-adhoc-error-shape` | errors use `c.error(...)`, not inline `c.json({ error }, 4xx/5xx)` | ADR-0008 |
| `kata/no-raw-boundary-cast` | a raw `as unknown`/`as never` boundary cast carries a `// kata-allow: hono-boundary` marker | ADR-0016 |
| `kata/schema-file-naming` | files in a module are named `<domain>.{route,service,schema}.ts` | ADR-0016 |
| `kata/no-decorator` | no `@decorator` syntax under `src/` | ADR-0002 |
| `kata/no-class` | no `class` declarations under `src/` | ADR-0002 |

See [Bootstrap CLI](/guide/cli) for the full command surface, including
`kata verify --watch` for a re-checking terminal loop.

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

It writes four files:

```
.claude/settings.json    Claude Code hooks + config-tampering bans
.codex/hooks.json        Codex hooks → kata verify --json
AGENTS.md                Canonical agent instructions (Codex + Claude)
CLAUDE.md                Claude entrypoint → imports AGENTS.md
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
parity is the point.

`kata init` scaffolds a complete runnable app on top of these harness files by
default; `--minimal` writes only the harness. See [Bootstrap CLI](/guide/cli) for
every flag.

## See also

- [Bootstrap CLI](/guide/cli) — the full `kata` command surface.
- [ADR-0007](/adr/0007-self-apply-harness-before-feature-work) — self-apply the harness before feature work.
- [ADR-0010](/adr/0010-ban-no-verify-and-config-tampering) — ban `--no-verify` and config tampering.
