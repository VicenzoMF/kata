---
name: kata-pr-review
description: Multi-agent Kata PR review. Dispatches portable sub-reviewers (summary, acceptance, regression) in parallel, then a consolidator. Each posts inline or PR-level comments with marker-prefixed bodies for dedup on re-runs. Use ONLY when explicitly asked to review a pull request — never trigger automatically during coding. Triggers: "/review", "/kata-pr-review", "review PR #N", "review this PR".
---

# `/kata-pr-review` — orchestration protocol

The static layer (Oxlint, Biome, typecheck, vitest, hurl, the verifier when
ADR-0007 sub-issues land) catches mechanical issues. This skill catches
**judgment** issues — requirements coverage, AI-regression patterns, and a
human-readable summary — and produces both inline comments (per finding) and
a PR-level summary.

Foundation port from Relay's `relay-pr-review` (see `/home/vicen/projetos/RelayRepos/Relay/.claude/skills/relay-pr-review/`).
This v0.0 ships **three reviewers + one consolidator**. The remaining four
(architecture, conventions, tests, security/performance) need Kata-anchored
content and land in follow-up PRs against issue #45.

## When to use

- The user says: "review the PR", "/review", "/kata-pr-review", or names a PR
  number.
- Before opening a PR, as a self-check (dry-run mode if no PR exists yet).
- Triggered automatically by `.github/workflows/pr-review.yml` when someone
  comments exactly `/review` on a PR.

When **not** to use:
- During coding or feature implementation. This skill is review-only; mid-
  feature invocation pollutes the PR with stale comments.
- Trivial diffs (typo, lockfile bump, single-line config nudge).
- PRs touching only non-source paths (lockfiles, generated `dist/`, image
  binaries).

---

## Universal Rules (every sub-agent MUST follow)

Non-negotiable across all sub-reviewers plus the consolidator. The contract
exists so re-runs don't pollute the PR and reviewers can trust the bot.

1. **Comment allowlist.** Inline comments may only be posted on lines in the
   diff starting with `+` (excluding `+++` headers). Context (` `) and
   removed (`-`) lines are out of scope.

2. **Skip duplicates.** Before posting, fetch existing inline comments with
   `gh api repos/{REPO}/pulls/{PR}/comments --paginate`. If a comment with
   marker `<!-- kata-review:{type} -->` already exists at the same
   `{path, line}` within ±3 lines, **skip**. Marker scope is "same type"
   (a regression finding doesn't dedup against an architecture finding).

3. **Mark resolved.** For each of YOUR previous comments
   (matching `<!-- kata-review:{type} -->`) where the offending pattern no
   longer appears in the latest diff, reply
   `<!-- kata-review:{type} --> [RESOLVED] This appears resolved by the latest changes.`

4. **Confidence guard.** Only post findings you're **≥80% confident on**.
   When uncertain, skip — false positives erode reviewer trust faster than
   missed issues.

5. **Positive highlight.** Include exactly **one** inline comment flagging
   something well-done in your scope. Format:
   `<!-- kata-review:{type} --> ✨ {type-emoji} {Short title} — {what you liked + why}`.
   If your scope has nothing notably good in this diff, you may skip.

6. **Marker prefix.** Every comment body MUST start with
   `<!-- kata-review:{type} -->` (HTML comment, invisible in rendered view).
   The consolidator parses this to group + dedup.

7. **Comment-only.** Use the inline-comment API
   (`gh api -X POST repos/{REPO}/pulls/{PR}/comments`). **Never** call
   `gh pr review --approve` or `--request-changes`. Never modify files.
   The reviewer is signal; the human is the decider.

8. **Tone.** Specific, actionable, collegial. Quote the offending line; name
   the **WHY** (cite ADR/AGENTS.md/doc when possible); give the **FIX** as a
   short concrete action.

### Severity & type emojis

```
Severity (per finding, lowercase):
🚨 blocker  — must fix before merge (security critical, broken contract, regression)
⚠️ major    — serious, should fix in this PR (clear bug, missed AC, anti-pattern hot-spot)
💡 minor    — suggestion / nit / forward-looking

Type emoji (one per agent type, on header line):
🔁 regression · ✅ acceptance · 📝 summary
(Reserved for follow-up agents: 🏛️ architecture · 📐 conventions · 🧪 tests · 🔒 security)
```

### Inline comment body format (universal)

```
<!-- kata-review:{type} -->
{severity-emoji} {type-emoji} {Short title}

{What the issue is, with the quoted offending line and the WHY citing ADR/doc.}

**Fix:** {concrete action — 1-2 sentences, code snippet if <6 lines}
```

Praise variant (universal rule #5):

```
<!-- kata-review:{type} -->
✨ {type-emoji} {Short title} — {what you liked and why}
```

---

## Step 1 — Initialize (orchestrator)

Run these in the shell to set up shared context. Pass into every sub-agent's
prompt.

```bash
PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null || echo "")
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD)
BASE_BRANCH=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo "main")
HEAD_SHA=$(git rev-parse HEAD)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

git fetch origin "$BASE_BRANCH"
DIFF_STAT=$(git diff "origin/$BASE_BRANCH...HEAD" --stat)
CHANGED_FILES=$(git diff "origin/$BASE_BRANCH...HEAD" --name-only)

EXISTING_COMMENTS=$(gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate 2>/dev/null || echo "[]")

PR_INTENT=$(gh pr view "$PR_NUMBER" --json title,body,headRefName 2>/dev/null || echo "{}")
LINKED_ISSUE=$(echo "$PR_INTENT" | jq -r '.body' | grep -oE 'Closes #[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "")
```

If `PR_NUMBER` is empty → **dry-run mode**: skip API/comment posting;
sub-agents print findings to their final message. The consolidator emits a
markdown report to `/tmp/kata-pr-review-$HEAD_BRANCH.md` + stdout.

Filter `CHANGED_FILES` to Kata source extensions:
`.ts .tsx .js .mjs .cjs .hurl .md .yml .yaml .json`. Skip lockfiles, `dist/`,
generated `node_modules/`.

Capture the full diff. If > ~15 000 tokens (~60 000 chars), truncate: drop
`.md` and `.test.*` first, then truncate from the diff tail. Note any
truncation — the consolidator surfaces it.

---

## Step 2 — Parallel dispatch (one message, multiple Agent calls)

**Critical:** dispatch all available reviewers via the `Agent` tool in a
**single message with multiple tool calls**. They MUST run in parallel.

Shared prompt block (same for all):

```
PR number: {PR_NUMBER or "(dry-run, no PR yet)"}
Repository: {REPO}
Head branch: {HEAD_BRANCH}
Head SHA: {HEAD_SHA}
Base branch: {BASE_BRANCH}
Linked issue: {LINKED_ISSUE or "(none — PR body has no Closes #N)"}

PR title: {PR title from gh pr view}
PR body:
{PR body, truncated to 2000 chars if longer}

Diff summary:
{DIFF_STAT}

Changed files (filtered to source extensions):
{one per line}

Full diff (possibly truncated — see notes at end):
{git diff output}

Existing inline review comments (for your dedup check):
{EXISTING_COMMENTS — full JSON array, sub-agent filters by its own marker}

{truncation note if applicable}
```

The agents shipped in this foundation PR, dispatched in parallel:

| Order | `subagent_type` | Marker type | Posting |
|---|---|---|---|
| 1 | `pr-reviewer-summary` | `summary` | One PR-level comment via `gh pr comment` |
| 2 | `pr-reviewer-acceptance` | `acceptance` | One PR-level comment via `gh pr comment` |
| 3 | `pr-reviewer-regression` | `regression` | Inline only |

Reserved for follow-up PRs against issue #45:
- `pr-reviewer-architecture` (Kata-anchored: ADR-0001..0005)
- `pr-reviewer-conventions` (AGENTS.md prohibitions: no `any`, no defaults,
  schemas in `<domain>.schema.ts`)
- `pr-reviewer-tests` (vitest + hurl coverage)
- `pr-reviewer-security` (small surface — likely combined with performance)

Wait for all dispatched agents to complete. Each returns a brief status
message (counts + brief reason for skips). The actual review output is in
posted comments, not in the agent's return message.

---

## Step 3 — Consolidation (one final sub-agent)

After the parallel dispatch finishes, dispatch **one more sub-agent**:
`pr-reviewer-consolidator`. It reads every `<!-- kata-review:* -->` comment
posted on the PR, groups by severity + type, dedups, detects coverage gaps,
and posts one PR-level summary comment.

Pass the consolidator the same shared context block as Step 2, plus the
current head SHA and the trigger user (`gh pr view --json author` for
self-dispatch, or the `issue_comment` payload's `user.login` for CI).

The consolidator output (one PR-level comment) follows the format in
`.claude/agents/pr-reviewer-consolidator.md`.

---

## Step 4 — Report to the invoker

After the consolidator finishes, return ONE final message to the user:

- **With PR**: `Posted Kata PR review on PR #{PR_NUMBER}: {URL of the consolidator summary comment}`
- **Dry-run**: `Dry-run report: /tmp/kata-pr-review-{HEAD_BRANCH}.md` (+ stdout dump)

If any sub-agent returned an error or failed to post, list it in a one-line
footer: `Note: {agent-name} reported {N} errors; see PR comment thread for details.`

---

## Costs / caveats

- Four total Sonnet invocations per `/review` (three reviewers + one
  consolidator). Foundation scope; expands to eight once the Kata-specific
  agents land.
- Sub-reviewers can be wrong. The ≥80% confidence filter targets a low
  false-positive rate, weighted toward `regression`. Treat findings as a
  checklist for human judgment, not a merge gate. The merge gate is
  `pnpm typecheck && pnpm test && hurl --test` + branch protection.
- Re-runs are designed to be cheap and clean — dedup by marker + `{path, line}`
  ±3 means the same finding doesn't get reposted.
- Dry-run mode skips API calls but still consumes the same token budget — use
  sparingly when no PR exists.
- The static layer is the **mechanical** gate; this skill is the **judgment**
  gate. If a finding here could be expressed as a lint rule or a `kata verify`
  check, prefer to add it there instead.

---

## Related

- `/review` (built-in) — single-agent generic reviewer. Use this skill in
  Kata once it's complete; the built-in is fine for trivial diffs.
- CI trigger: comment `/review` on any open PR fires
  `.github/workflows/pr-review.yml`, which invokes this skill via
  `anthropics/claude-code-action` with `CLAUDE_CODE_OAUTH_TOKEN`.
- Issue #45 tracks completion of the remaining Kata-anchored agents.
