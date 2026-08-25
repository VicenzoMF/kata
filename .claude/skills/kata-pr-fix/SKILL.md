---
name: kata-pr-fix
description: Work through review feedback on a Kata PR — collect every inline and PR-level comment (including the kata-review bot's), verify each against the codebase before implementing, push back with technical reasoning where the suggestion is wrong, fix, reply in-thread, and re-run the gates. Use when asked to address, apply, or respond to PR review comments. Triggers: "/kata-pr-fix", "corrige o PR", "address the review comments", "apply the feedback on PR #N".
---

# `/kata-pr-fix` — from review feedback to a green PR

`/kata-pr-review` produces the signal; this skill consumes it. The job is
**technical evaluation, not compliance** — a review comment is a hypothesis
about the code, and some of them are wrong.

Depth comes from `superpowers:receiving-code-review`, whose reception protocol
this skill inherits wholesale (verify before implementing, no performative
agreement, clarify everything before implementing anything). What follows is
the Kata-specific layer.

## When to use

- A PR has review comments — human, `kata-review:*` bot, or CodeRabbit-style
  external — and the user wants them handled.
- CI is red on a PR and the fix belongs on that branch.

**Not** for: producing the review (`/kata-pr-review`), or new work that isn't
feedback on this PR (that's a new issue via `/kata-issue-plan`).

---

## Step 1 — Collect everything

Inline comments and PR-level comments live in different APIs. Fetch both, or
you will silently skip half the feedback.

```bash
PR={N}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

gh api "repos/$REPO/pulls/$PR/comments" --paginate   # inline (file + line)
gh api "repos/$REPO/issues/$PR/comments" --paginate  # PR-level (summary, acceptance)
gh pr view "$PR" --json reviews,statusCheckRollup     # formal reviews + CI
gh pr checks "$PR"                                    # failing gates
```

Also pull the linked issue's `**Acceptance:**` block (`Fixes #N` in the PR
body) — the `kata-review:acceptance` comment grades against it, and a ❌ there
outranks every nit.

Check out the branch and rebase on `main` before touching anything:

```bash
gh pr checkout "$PR" && git fetch origin main && git rebase origin/main
```

## Step 2 — Triage before implementing

Build one todo per comment, then classify each — this is the step people skip
and it is the whole point of the skill:

| Verdict | Meaning | Action |
|---|---|---|
| **Accept** | Correct and in scope | Fix it |
| **Accept, defer** | Correct but a separate concern | Open a follow-up issue, link it in the reply |
| **Push back** | Technically wrong for this codebase | Reply with the reasoning + evidence, do not change the code |
| **Needs clarification** | Ambiguous, or two comments conflict | Ask **before** implementing anything |

Verify every finding against the repo yourself. Bot comments carry an ≥80%
confidence guard, not a proof — and AI reviewers hallucinate line numbers,
phantom APIs, and rules that don't exist. Concretely:

- A comment citing an ADR → open the ADR and check it actually says that.
  Kata has had issues (#261) about source citing a *phantom* ADR number.
- A comment about a rule → check whether `kata verify` actually ships it
  (`pnpm exec kata verify --strict-coverage`). If the code passes the gate and
  the reviewer says otherwise, the reviewer is claiming a rule that isn't
  enforced; say so.
- A comment asking for a "proper" implementation of something unused → grep
  first. YAGNI wins unless a caller exists.

If items are related and any one is unclear, **stop and clarify all of them**
before implementing any — partial understanding produces a wrong fix that
looks finished.

Anything that conflicts with an `Accepted` ADR is not a code exception: it is
either wrong, or it needs a superseding ADR. Escalate rather than silently
deviating.

## Step 3 — Fix, in order, one at a time

1. Blocking (🚨 blocker, failing CI, broken contract, missed acceptance bullet)
2. Simple (typo, import, naming, doc wording)
3. Complex (refactor, logic, type design)

One fix per comment, verified individually. Batching means you can't tell
which change broke what. Keep the same constraints as the original work —
mandatory layout, no `any`, schemas in `<domain>.schema.ts`, `input` + `output`
on every route, no config edits to silence a lint rule, never `--no-verify`.

Do not expand scope while fixing. A review comment is not a license to
refactor the neighborhood; `pr-reviewer-regression` flags unrelated deletions
and drive-by changes on the next pass.

## Step 4 — Reply in the thread

Inline feedback gets an inline reply, not a top-level PR comment:

```bash
gh api -X POST "repos/$REPO/pulls/$PR/comments/{COMMENT_ID}/replies" \
  -f body="Fixed in <sha> — <what changed>."
```

Tone rules, inherited from `superpowers:receiving-code-review` and worth
restating because they are violated constantly:

- ✅ `Fixed in abc1234 — schemas moved to todos.schema.ts.`
- ✅ `Checked ADR-0004: scoped() is the required mechanism here, so the
  suggested module-level cache would be a request-state leak. Leaving as is.`
- ❌ "You're absolutely right!" / "Great catch!" / "Thanks for the feedback!"

Push back with evidence — quote the ADR line, the test, the gate output. If
you pushed back and were wrong, say so factually in one sentence and fix it.

For the bot's own comments, the `[RESOLVED]` reply convention lives in
`.claude/skills/kata-pr-review/SKILL.md` — the reviewer marks its own findings
resolved on the next run, so you don't need to.

## Step 5 — Re-run the gates and push

```bash
pnpm exec kata verify --strict-coverage
pnpm typecheck
pnpm test
pnpm --filter=<example> hurl        # if a route or contract moved
git push
```

Update the PR body's `## Test plan` if the set of commands changed, and add a
short comment summarizing the round:

```markdown
Review round N addressed:
- ✅ <comment> — fixed in <sha>
- ↩️ <comment> — pushed back: <one-line reasoning>
- 📌 <comment> — deferred to #<new issue>

Gates re-run: kata verify --strict-coverage ✅ · typecheck ✅ · test ✅
```

## Step 6 — Report

Tell the user: how many comments, the split across the four verdicts, anything
you pushed back on (they may want to overrule you), and any follow-up issues
opened. Never `gh pr review --approve` your own PR — the reviewer is signal,
the human is the decider.
