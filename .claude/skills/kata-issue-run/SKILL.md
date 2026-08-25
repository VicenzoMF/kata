---
name: kata-issue-run
description: Implement a Kata GitHub issue end to end — branch, code inside the mandatory module layout, run the four verification gates, and open a PR in the repo's house format with a Test plan and Fixes #N. Use when asked to work on, implement, or "run" an issue. Triggers: "/kata-issue-run", "implementa a issue #N", "work on #N", "pega a #N".
---

# `/kata-issue-run` — issue to green PR

The issue is the contract; the `**Acceptance:**` bullets are the definition of
done, and `.claude/agents/pr-reviewer-acceptance.md` will grade your diff
against them. This skill covers branch → implementation → gates → PR.

Depth comes from the `superpowers` plugin: `superpowers:executing-plans` for
inline batch execution, `superpowers:subagent-driven-development` when the plan
has independent tasks worth a fresh reviewer per task, and
`superpowers:test-driven-development` for the red/green cycle. This skill
supplies the Kata gates and conventions those skills don't know.

## When to use

- The user names an issue to implement.
- A `/kata-issue-plan` session just produced an issue and the user said go.

**Not** for: opening the issue (`/kata-issue-plan`), reviewing a PR
(`/kata-pr-review`), or acting on review feedback (`/kata-pr-fix`).

---

## Step 1 — Load the contract

```bash
gh issue view {N} --json number,title,body,labels,milestone
```

Extract the `**Acceptance:**` bullets verbatim into your todo list — one todo
per bullet. These are what you get graded on. Also read:

- Every ADR the issue cites, plus any ADR governing the files you'll touch
  (`ls docs/adr/`). **Read the ADR before deviating from it** — that's an
  `AGENTS.md` rule, not a suggestion.
- `AGENTS.md` prohibitions, restated below because they are the top source of
  review findings.

If a bullet is ambiguous, ask **before** writing code. A wrong reading costs a
full review round; a question costs one message.

## Step 2 — Branch

Never implement on `main`.

```bash
git fetch origin main && git switch -c <type>-<slug>-<issue-number> origin/main
```

Naming follows the merged history: `docs-boolean-query-recipe-282`,
`docs-mcp-publish-guard-280` — `<area>-<slug>-<issue#>`. For work that touches
many files in parallel with another task, use
`superpowers:using-git-worktrees` instead of stacking on one checkout.

## Step 3 — Implement inside the constraints

The layout is mandatory (`AGENTS.md`), not a suggestion:

```
src/
├── app.ts                # createApp({ context, modules })
├── context.ts            # defineContext({ ... })
├── middlewares/
└── modules/<domain>/
    ├── <domain>.route.ts     # defineRoute calls only
    ├── <domain>.service.ts   # pure functions
    ├── <domain>.schema.ts    # Zod schemas (DTOs)
    ├── <domain>.hurl         # API E2E
    └── <domain>.test.ts      # unit tests
```

Hard rules, each of which a reviewer will flag:

| Rule | Source |
|---|---|
| Functional only — no classes, no decorators | ADR-0002 |
| Named exports only — no default exports | AGENTS.md |
| `any` is forbidden — `unknown` + narrowing | AGENTS.md |
| Every route declares `input` **and** `output` | ADR-0003 |
| Schemas live in `<domain>.schema.ts`, never inline in `.route.ts` | ADR-0005 |
| Request-scoped state only via `scoped<T>()` | ADR-0004 |
| Never edit lint/framework config to silence an error — fix the code | AGENTS.md |
| Never `--no-verify`, never `SKIP=` | ADR-0010 (hook-enforced) |

The `PreToolUse` / `PostToolUse` hooks in `.claude/settings.json` will fight
you on the last two. They are correct; do not route around them.

**Scope discipline.** Touch only what an acceptance bullet requires. Unrelated
deletions, drive-by refactors, and "while I'm here" cleanups are exactly what
`pr-reviewer-regression` hunts for. Something genuinely broken but out of
scope → open a follow-up issue and link it.

**Docs are bilingual.** A change to `docs/guide/*` or `docs/cookbook/*` usually
has a `docs/pt/` counterpart. Check for it; PR #285 shipped EN + PT together.

## Step 4 — The four gates

Run all of them before opening the PR. These exact commands go into the PR's
Test plan, so run them for real — never check a box you did not observe pass.

```bash
pnpm exec kata verify --strict-coverage   # determ checks; strict = fail on unprovable
pnpm typecheck                            # tsc --noEmit across workspaces
pnpm test                                 # vitest
pnpm --filter=<example> hurl              # only if a route/contract changed;
                                          # needs `pnpm --filter=<example> start`
```

`pnpm check` runs format + lint + typecheck + test + hook tests in one shot —
use it as the catch-all before pushing. If `pnpm` is missing on a fresh
machine: `npm i -g pnpm@10.32.1` (the version pinned in `packageManager`),
then `pnpm install`.

A failing gate is a stop condition, not a footnote. Fix it or report it.

## Step 5 — Commit and open the PR

Conventional-commit subjects, matching the issue's prefix. Small, focused
commits; let the hooks run.

PR body follows the house format (see #285, #287):

```markdown
## Summary
- <what changed and why, in the reviewer's terms — not a file list>
- <the non-obvious judgment call, if any>

## Verification
<only when correctness isn't self-evident from the diff — paste the actual
observed output: parse results, before/after behavior, command transcripts>

## Test plan
- [x] `pnpm exec kata verify --strict-coverage` — no problems found
- [x] `pnpm typecheck` — clean
- [x] `pnpm test` — N passed
- [x] `pnpm --filter=hello hurl` — N/N requests OK

Fixes #{N}
```

Use `Fixes #N` when the PR fully satisfies every acceptance bullet, and
`Towards #N` when it doesn't — with a line saying what remains and who does it
(#287 does exactly this for a manual `npm publish` step).

If manual steps remain for the maintainer after merge (publishing, tagging),
list them as a copy-pasteable block under `## Remaining manual steps (owner,
after merge)`.

```bash
git push -u origin HEAD
gh pr create --title "<conventional title>" --body-file /tmp/pr-body.md
```

## Step 6 — Self-review before handing over

Re-read the acceptance bullets against your own diff and answer, for each:
implemented, or not — and if not, why. That is the same question
`pr-reviewer-acceptance` will ask; finding the gap yourself is cheaper.

Then offer `/kata-pr-review` for the full multi-agent pass.

## Stop conditions

Stop and ask rather than guessing when:

- An acceptance bullet is ambiguous or contradicts an ADR.
- The fix requires deviating from an `Accepted` ADR (that needs a superseding
  ADR, not a code exception).
- A gate fails for a reason you can't trace to your own change.
- The work turns out to be materially bigger than the issue describes — that's
  a re-split conversation, not a bigger PR.
