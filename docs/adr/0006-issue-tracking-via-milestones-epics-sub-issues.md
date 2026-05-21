# ADR-0006: Issue tracking via GitHub milestones, epics, and sub-issues

- **Status:** Accepted
- **Date:** 2026-05-21
- **Deciders:** @VicenzoMF

## Context

The harness-engineering article and our own ADR practice insist that any
authoritative state about the project must live somewhere mechanically
inspectable, not in prose that rots. As Kata's scope grew across this design
sprint (multiple parallel work streams: verifier, RPC types, runtime polish,
harness integration, docs), keeping the work-in-flight catalogued purely in
chat or memory stopped being viable.

The team needs:

- A single source of truth for "what is still to do."
- Grouping that makes sense for a small OSS project (no PMs, no Jira).
- First-class support in GitHub so the tracking lives next to the code, ADRs,
  and PRs that resolve each item.
- Cross-linkability between issues, ADRs, and commits.

## Decision

We will use **GitHub Issues, Milestones, and the native sub-issue feature** as
the tracking primitive. There is no separate Jira / Linear / ClickUp board.

The mapping is:

- **Milestone** — a time- and version-bound release target. We open one per
  intended Kata version (`v0.1`, `v0.2`, `v0.3`, eventually `v1.0`). Issues
  carry a milestone when their completion contributes to that release.
- **Epic** — a long-lived parent issue, tagged with the `epic` label, that
  groups all sub-issues for one coherent work stream. Epics do not have a
  milestone of their own; their sub-issues do.
- **Issue** — the unit of work. Always tagged with at least one functional
  label (e.g. `lint-rule`, `runtime`, `harness`), and usually carries a
  milestone.
- **Sub-issue** — a regular issue, linked to its epic via the GitHub
  sub-issue API (`POST /repos/.../issues/{epic}/sub_issues`). Sub-issues
  appear in the epic's "Sub-issues" panel and roll up progress automatically.

GitHub does not have a first-class "Epic" type. The `epic`-labeled parent
issue is the convention used by GitHub's own internal teams and many OSS
projects since the sub-issue feature shipped (2024).

### Labels

The label set established in this ADR:

| Label | Color | Meaning |
|---|---|---|
| `epic` | purple | Parent issue grouping sub-issues |
| `adr-needed` | yellow | Decision pending; ADR must land before implementation |
| `lint-rule` | blue | A specific rule shipped by `kata verify` |
| `type-system` | green | Type-level inference or TS magic |
| `runtime` | gray | Request-time framework behavior |
| `harness` | orange | Claude Code / Codex hooks integration |
| `docs` | cyan | README, cookbook, ADRs |
| `breaking-change` | red | Public API change |

Additions are encouraged when a new theme emerges (e.g. `perf`, `security`),
but renaming or removing an existing label requires a superseding ADR.

### Initial epics

Six epics opened in tandem with this ADR (`gh issue list --label epic`):

1. **Epic: kata verify CLI + lint rules** — 9 sub-issues across v0.1 / v0.2.
2. **Epic: End-to-end RPC typing** — 4 sub-issues, v0.1.
3. **Epic: Runtime polish** — 4 sub-issues, v0.1 / v0.2.
4. **Epic: ADR follow-ups** — 4 sub-issues, rolling.
5. **Epic: Harness integration (kata init)** — 5 sub-issues, v0.2.
6. **Epic: Documentation & examples** — 4 sub-issues, v0.1 / v0.2.

## Alternatives considered

### External tracker (Linear / Jira / ClickUp)
Rejected. Adds a second source of truth, requires another login, and breaks
the "everything next to the code" principle. The cost-benefit only flips at
team sizes Kata does not yet have.

### Markdown task lists in README or ROADMAP.md
Rejected. Rots. Encoding state in prose is exactly what ADR-0001 (and the
harness-engineering article) push back against — there is no mechanical
linkage between a checkbox in a markdown file and the commit that closes it.

### GitHub Projects (table / kanban) as the primary surface
Deferred. A Projects board can be layered on top of these issues later if
the volume justifies it. For now, the epic + sub-issue rollup is enough
without the extra ceremony.

### "Epic" implemented as a milestone
Rejected. Milestones are time-bound (a release target); epics are scope-bound
(a coherent work stream). Conflating them obscures both. A single epic
typically spans more than one milestone.

## Consequences

### Positive
- Single source of truth, queryable via `gh issue list`.
- Sub-issue rollup gives "% done per epic" without any external tooling.
- Issues link to ADRs and PRs naturally via `#NNNN` references.
- Bots, CI, and external automations can read state via the GitHub API.
- Onboarding a contributor takes one query: `gh issue list --label epic`.

### Negative / costs
- GitHub's sub-issue feature is relatively young (2024). API stability is
  good enough but not guaranteed.
- Creating 30+ issues at once is a one-time bootstrapping cost; ongoing
  cost is one issue per piece of work, which is the same as any tracker.
- Closing an epic still requires manually closing all sub-issues; rollup
  shows percentage but does not auto-close the parent.

### Follow-ups
- A short CONTRIBUTING.md should reference this ADR and explain the label
  taxonomy to drive-by contributors.
- Decide whether a Projects board (kanban view) is worth standing up once
  the open-issue count exceeds ~50.

## Companion rules

No lint rules — this ADR governs project management, not code. Drift is
caught by humans reviewing the issue tracker, not by `kata verify`.
