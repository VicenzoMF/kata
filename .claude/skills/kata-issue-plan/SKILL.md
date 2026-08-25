---
name: kata-issue-plan
description: Turn a rough idea, bug report, or doc-feedback finding into a Kata-standard GitHub issue plus an implementation plan. Researches ADRs and docs first, writes the issue in the repo's house format (context prose + **Acceptance:** bullets), links it to an epic per ADR-0006, and stops before any code is written. Triggers: "/kata-issue-plan", "abrir issue", "plan this issue", "turn this into an issue", "refine issue #N".
---

# `/kata-issue-plan` — from idea to a well-formed issue

Kata tracks all work as GitHub issues under milestones and `epic`-labeled
parents ([ADR-0006](../../../docs/adr/0006-issue-tracking-via-milestones-epics-sub-issues.md)).
An issue is only useful to the next agent if it carries enough context to be
implemented without re-deriving the investigation. This skill produces that
issue — and nothing else. **It never edits source.**

Depth comes from the `superpowers` plugin: use `superpowers:brainstorming` to
pressure-test a fuzzy idea before writing, and `superpowers:writing-plans` when
the work needs a task-by-task plan document. This skill supplies the Kata
house rules those generic skills don't know.

## When to use

- The user describes a bug, gap, or feature and wants it tracked.
- A doc-feedback / POC run surfaced findings that need splitting into issues.
- An existing issue is too thin to hand to an implementer (`refine issue #N`).

**Not** for: implementing (that's `/kata-issue-run`), reviewing a PR
(`/kata-pr-review`), or reacting to review feedback (`/kata-pr-fix`).

---

## Step 1 — Ground the claim in the repo

Never write an issue from the user's description alone. Every claim in the
body must be one you verified on `main` at HEAD.

```bash
git fetch origin main && git log --oneline -5 origin/main
```

Then, as applicable:

- **Read the governing ADR.** `ls docs/adr/` — if the idea touches an existing
  decision, the issue must cite it by number and either work inside it or say
  explicitly that a superseding ADR is needed (label `adr-needed`).
- **Reproduce.** For a bug, get the actual failing output — a `pnpm test`
  excerpt, a `pnpm exec kata verify --strict-coverage` finding, a `tsc` error,
  a real `parse()` result. Paste it in the issue verbatim.
- **Check for duplicates.** `gh issue list --state all --search "<keywords>"`.
  If it exists, comment there instead of opening a second one.
- **Locate the code.** Name the exact files and, where useful, `path:line`.

If a claim does not survive this step, drop it. An issue asserting something
false costs the next agent more than no issue at all.

## Step 2 — Right-size

One issue = one reviewable PR. Split when:

- Two fixes could be merged independently (see #280 / #283: process fix and
  the immediate action item were split, cross-linked, and shipped separately).
- The work spans an ADR decision *and* its implementation — the ADR lands
  first, labeled `adr-needed`.
- The acceptance list would exceed ~6 bullets covering unrelated surfaces.

If splitting produces 3+ related issues, open an `epic`-labeled parent and
attach the children as sub-issues (Step 4).

## Step 3 — Write the body in house format

Kata issues are prose-then-acceptance. There is no template file; this is the
shape every recent issue uses (see #281, #283).

```markdown
<one-line provenance: where this came from — a POC run, a PR review, split
out of #N, a user report. Include "Confirmed still present on `main`" when
you verified it.>

<2-5 paragraphs of evidence. Quote the offending doc line or code. Say what
actually ships today vs. what is documented. Name files and line numbers.
Explain the cost to whoever hits it — usually "an agent following only the
docs has to infer X, which isn't stated anywhere".>

**Acceptance:**
- <observable, checkable outcome — not a task list>
- <each bullet must be verifiable by reading the diff or running a command>
- <scope fences belong here too: "Leave the CI prevention to #280.">
```

Rules for the `**Acceptance:**` block — it is a contract, not decoration.
`.claude/agents/pr-reviewer-acceptance.md` parses it on every PR review and
grades the diff against each bullet.

- Phrase each bullet as a **state**, not an activity ("`services.md` prose and
  every example agree on `<domain>.test.ts`", not "fix services.md").
- Anything out of scope gets its own bullet saying so, with the issue number
  that owns it.
- If the fix must be verified by running something, name the exact command.

## Step 4 — Title, labels, milestone, epic

**Title:** conventional-commit prefix + the symptom, not the fix.
`fix(runtime): …`, `docs(cookbook): …`, `chore(docs-mcp): …`,
`question(verify): …`, `feat(cli): …`.

**Labels** — at least one functional label (ADR-0006's taxonomy):
`lint-rule` · `runtime` · `type-system` · `docs` · `harness` · `cli` ·
`security` · `breaking-change` · `adr-needed`, plus `bug` / `enhancement` /
`question` and `priority: high` when it blocks correctness or safety.

**Milestone:** only when completion contributes to that release. Epics carry
no milestone of their own — their sub-issues do.

```bash
gh issue create --title "<title>" --body-file /tmp/issue-body.md \
  --label "<functional>,<kind>" --milestone "<v0.N — …>"

# attach to an epic (ADR-0006 uses the native sub-issue API)
gh api -X POST repos/{owner}/{repo}/issues/{EPIC}/sub_issues \
  -F sub_issue_id="$(gh issue view {N} --json id -q .id)"
```

Write the body with a heredoc to a temp file — `--body` mangles backticks and
newlines in fish.

## Step 5 — Plan document (only when the work is multi-step)

For anything larger than a single-file fix, follow up with
`superpowers:writing-plans`, with these Kata overrides:

- **Every task must land in the mandatory layout.** `AGENTS.md` fixes
  `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts`. A plan
  that invents a `utils/` or `handlers/` directory is wrong before it starts.
- **Every route task declares `input` and `output` schemas** (ADR-0003), with
  the schemas in `<domain>.schema.ts`, never inline in the route (ADR-0005).
- **Verification steps use the real gates**, in this order:
  `pnpm exec kata verify --strict-coverage`, `pnpm typecheck`, `pnpm test`,
  and `pnpm --filter=<example> hurl` when a route changed.
- **No `any`, no classes, no decorators, no default exports** — restating the
  prohibition inside the plan is cheaper than a review round.

## Step 6 — Hand back

Report to the user: the issue URL, its labels/milestone/epic, and the one
judgment call you made that they might want to overturn (scope fence, split,
label choice). Then offer `/kata-issue-run #N`.

**Never** start implementing in the same turn. Planning and execution are
separate sessions on purpose — the issue is the handoff artifact.
