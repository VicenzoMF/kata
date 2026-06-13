# ADR-0010: Ban `--no-verify` and config tampering

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** @VicenzoMF

## Context

The harness-engineering article names two "cheat paths" an agent reaches for
the moment a check goes red — both of which turn a failing signal green
without touching the code that failed:

1. **Bypass the commit-time gate.** `git commit --no-verify` (and its short
   form `-n`), `git push --no-verify`, and `SKIP=<hook> ...` all skip Lefthook
   (format / lint / typecheck) and the pre-push gate.
2. **Edit the rule itself.** Delete an Oxlint rule, widen `tsconfig.json`,
   blank a CI workflow, or rewrite a hook script — the check passes because the
   check is gone.

ADR-0007 introduced both bans as part of the v0.0 Minimum Viable Harness, but
spread their enforcement across a Lefthook config, a PreToolUse hook, and a
`permissions.deny` list without a single place that names the contract. Two
things now need that single place:

- **Citability.** A blocked agent (and a human reading the block) should be
  able to follow one ADR for the rule *and* the reason.
- **Shipping it downstream.** Epic #26 (`kata init`) makes the harness the
  framework's differentiator. The config-tampering ban can no longer be an
  in-repo convention enforced by bespoke scripts — it has to be a contract
  `kata init` reproduces in every project it scaffolds.

## Decision

We will ban, mechanically and identically across every agent harness:

1. **Verification bypasses:** `git commit --no-verify`, `git commit -n`,
   `git push --no-verify`, and any `SKIP=<hook>` env prefix.
2. **Agent writes to the protected config set** — lint / format / build /
   framework configs plus the harness's own files:
   `biome.json`, `.oxlintrc*`, `tsconfig*.json`, `lefthook.yml`,
   `kata.config.ts`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `.github/workflows/*`, `docs/adr/*.md`, `.claude/settings.json`,
   `.claude/hooks/*`, `.codex/hooks.json`, `.codex/hooks/*`.

This set is the **single source of truth**. Both the in-repo hook scripts and
the generated `permissions.deny` lists implement it; when the set changes, it
changes here first.

### Enforcement layers (defense in depth, fail-closed)

- **Claude Code** — `permissions.deny` denies the bypass commands *and*
  `Edit`/`Write`/`MultiEdit` of the protected config set (deny rules are
  per-tool, so each path is denied for all three write tools). The PreToolUse
  hook is the second layer.
- **Codex** — has no `permissions.deny` slot, so its PreToolUse hook enforces
  the identical set: command bans inline, path protection by delegating to the
  Claude hook. Parity is by construction, not by copy.
- **`kata init` (downstream)** — generates the same contract: the commit/push
  bans and the config-edit denials in `.claude/settings.json`, with the Codex
  side delegating to the `kata verify --json` PreToolUse hook (Codex has no
  deny slot, exactly as in-repo).

### Why both a deny list and a hook

`permissions.deny` is native, needs nothing installed, and protects a freshly
`kata init`-ed project from its very first session — before any `kata verify`
ruleset exists. The hook is where path logic carries an ADR-anchored
explanation and where Codex (no deny slot) enforces the same rules. Neither
alone covers both harnesses from the first session; together they do.

### Humans still need to edit these files

The bias is **always block in the agent flow**. A human edits a protected
config from a non-agent shell. There is no reliable in-hook human/agent
discriminator and we do not try to build one (issue #43).

## Alternatives considered

### Alternative A — Prompt-only ("please don't bypass checks")
Rejected. The article's thesis is "enforce with mechanisms, not prompts."
Informal rules erode within a handful of sessions — the exact failure mode the
harness exists to prevent.

### Alternative B — CI-only enforcement (L3)
Rejected as the sole mechanism. CI catches a bypass only after the agent has
declared done and pushed: the feedback is minutes late and burns a remote run.
The L1/L2 layers fail closed locally, before the bad state leaves the machine.

### Alternative C — `permissions.deny` only, no hook
Rejected. Codex has no `permissions.deny`; a deny-only design leaves every
Codex session unprotected and breaks parity. Deny rules are also per-tool with
no ADR-anchored message — the hook is what makes the rule *and* its reason
visible to the agent.

### Alternative D — Runtime-only (`kata verify` blocks edits)
Rejected as the sole mechanism. `kata verify` must be installed and built to
enforce anything, so a freshly scaffolded project would be unprotected until
then. Native `permissions.deny` rules protect from session one; `kata verify`
is an additional layer, not the floor.

## Consequences

### Positive
- The two cheapest cheat paths are closed locally, for Claude *and* Codex,
  in-repo *and* in every `kata init` project.
- The contract is citable: hook stderr and this ADR point at the same reason.
- `kata init` ships the protection by default — the Epic #26 differentiator is
  real from the first session, not contingent on a built `kata verify`.

### Negative / costs
- Over-strict at the edges: a legitimate config change must be made from a
  non-agent shell — friction for a solo maintainer.
- The protected set is expressed in two forms (in-repo hook scripts and the
  generated/declared deny lists) and can drift. This ADR is the reconciliation
  point; the generated deny list is built from a single array in
  `packages/kata/src/cli/templates/harness.ts` to minimize drift on that side.

### Follow-ups
- Symmetric `.codex/*` protection inside the Claude `pre-tool-use.sh` (today
  the Codex hook self-protects those paths inline; tracked separately).
- A `kata verify` runtime config-protection rule so generated Codex projects
  get path-level enforcement without relying solely on hook delegation.
- A possible relaxation window allowing ADR edits before `Status: Accepted`
  (noted as a follow-up in ADR-0007).

## Companion rules

Mechanical enforcement of this ADR lives in:

- `.claude/settings.json` `permissions.deny` + `.claude/hooks/pre-tool-use.sh`
  (in-repo).
- `.codex/hooks/pre-tool-use.sh` — command bans + per-path delegation
  (in-repo Codex).
- `packages/kata/src/cli/templates/*` — the `kata init` templates that ship the
  same `permissions.deny` contract to downstream projects.

No new `kata/<rule-id>` archgate lint rule is introduced: enforcement is hook-
and permission-based, not lint-based. Supersedes nothing; complements ADR-0007.
