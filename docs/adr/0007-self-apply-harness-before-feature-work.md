# ADR-0007: Self-apply the harness before any framework feature work

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

Kata's thesis (README, ADR-0001..0005) is "agent-driven web framework with
harness-engineering shipped natively." Two facts about that thesis matter
for project sequencing:

1. The article we built this design on
   ([harness-engineering best practices, 2026](https://nyosegawa.com/en/posts/harness-engineering-best-practices-2026/))
   explicitly warns: *"scaling without a harness creates compounding cognitive
   debt, not compounding leverage. Polish your harness with one agent first,
   then scale."*

2. Kata's differentiator vs. Elysia / Hono+Zod templates is precisely the
   harness — the verifier, the hooks, the ADR-coupled lint rules. If we
   build Kata's features without using that pattern on Kata itself, we ship
   a thesis we never tested on ourselves.

Continuing into v0.1 feature work (RPC types, runtime polish, `kata verify`)
without first applying the article's Minimum Viable Harness to this repo
would be hypocritical: every commit during v0.1 would benefit from the
format / lint / typecheck / test / review loop we're claiming to be the
product's central value.

## Decision

A new milestone, **v0.0 — Self-applied harness**, precedes all feature
milestones. v0.1, v0.2, and v0.3 are formally **blocked** by v0.0; no work
on those milestones begins until v0.0 closes.

v0.0 ships the article's Minimum Viable Harness, scoped to the Kata repo's
own development:

1. **Formatter** — Biome, monorepo-wide.
2. **Linter** — Oxlint with the article's AI-anti-pattern rules
   (`no-explicit-any` as error, no default exports, etc.).
3. **Local feedback loop** — Lefthook pre-commit running format / lint /
   typecheck on changed files, plus a structural ban on
   `git commit --no-verify` for agent sessions.
4. **Millisecond feedback loop** — `.claude/settings.json` PostToolUse hook
   that auto-fixes and injects remaining violations as
   `hookSpecificOutput.additionalContext`.
5. **Completion gate** — Stop hook running typecheck + tests; agents cannot
   declare a session done with red checks.
6. **Safety gates** — PreToolUse hooks blocking edits to ADRs (immutable),
   linter configs, lockfiles, and CI workflows.
7. **Codex parity** — `.codex/hooks.json` mirroring the four hooks, with the
   Bash-matcher workaround documented in the article.
8. **Review subagent** — `.claude/agents/code-reviewer.md` that reads ADRs
   and produces ADR-anchored review comments on changes.
9. **Remote feedback loop** — GitHub Actions CI typecheck + lint + test +
   Hurl as a required check for merge.
10. **API E2E** — Hurl tests replacing the manual `curl` smoke we ran
    during the v0 bootstrap.

These ten items are tracked as the sub-issues of Epic #37 under milestone
v0.0.

The "blocking" relationship is documented in:
- Each blocked milestone's description (`**Blocked by v0.0**`).
- This ADR.
- The Epic 7 description.

## Alternatives considered

### Build features first, harness later
Rejected. This is the explicit anti-pattern called out by the article
("scaling without a harness"). Every v0.1 commit done without the harness
in place becomes a future cleanup target — exactly the AI-slop accumulation
OpenAI documented spending every Friday on.

### Trust ourselves to follow the article informally
Rejected. The whole point of harness engineering is "enforce quality with
mechanisms, not prompts." Trusting two humans (and any agent we use) to
remember the rules informally is precisely the failure mode the article
exists to fix. Without mechanical enforcement, the rules erode within a
handful of sessions.

### Partial harness now, complete it as we go
Rejected. The ten items in v0.0 form a tightly coupled set: the
PostToolUse hook needs the linter to exist; the Stop hook needs the test
infrastructure; the review subagent needs ADRs as authoritative source.
Cherry-picking half of them creates incoherent feedback loops where the
agent gets contradictory signals across layers.

### Make v0.0 optional / experimental
Rejected. If v0.0 is optional, it becomes the work that always gets
deferred when feature work is "more interesting." Making it block v0.1+
formally is the cheapest enforcement mechanism — the milestone tracker
itself enforces the order.

## Consequences

### Positive
- Every v0.1+ commit benefits from format / lint / typecheck / test /
  review without humans remembering to invoke them.
- The v0.0 setup becomes the literal blueprint for what `kata init` will
  ship (Epic #26). We're our own first user; the cookbook writes itself.
- Demonstrates externally that the framework's claim is real before any
  v1.0 release. Open-source credibility.
- The article's "investing in a harness compounds" applies starting today
  rather than starting at v1.0.

### Negative / costs
- v0.1 feature work (RPC types, etc.) is delayed by an estimated
  1–2 weeks of harness setup.
- The review subagent and code-reviewer agent are relatively unproven
  patterns; setup time may overrun.
- Some PreToolUse rules will be over-strict at first and require iteration
  (a future ADR may relax them, e.g. allowing ADR edits within a window
  before `Status: Accepted`).

### Follow-ups
- An ADR amendment may be needed once we learn which PreToolUse rules
  are wrong-strict in practice.
- CONTRIBUTING.md (currently absent) should reference this ADR and explain
  to drive-by contributors why their first PR will see the full loop.
- Once v0.0 closes, write a short retrospective ADR ("what worked, what
  didn't, what we changed mid-flight").

## Companion rules

No lint rules from this ADR directly. Each v0.0 sub-issue ships its own
enforcement mechanism (Lefthook config, hook script, CI workflow). The
ADR's mechanical enforcement is the milestone tracker: v0.1+ issues cannot
be acted on until v0.0 closes.
