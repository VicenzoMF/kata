# Kata — Claude Code Instructions

See @AGENTS.md for the canonical instructions (shared with Codex and other agents).

Claude-specific notes:
- `.claude/settings.json` defines PostToolUse / PreToolUse / Stop hooks once
  the verifier exists (currently no-op).
- Use `kata verify --json` in PostToolUse to inject feedback as
  `hookSpecificOutput.additionalContext`.

## Skills — the issue→PR loop

Four skills in `.claude/skills/` cover one stage each. They are model-invoked
(the `description` frontmatter carries the trigger phrases) or callable by
name:

| Stage | Skill | Produces |
|---|---|---|
| Plan | `/kata-issue-plan` | A GitHub issue in house format (evidence prose + `**Acceptance:**`), labelled and linked per ADR-0006 |
| Execute | `/kata-issue-run` | A branch, the implementation, the four gates, and a PR with `Fixes #N` |
| Review | `/kata-pr-review` | Parallel sub-reviewers + consolidator, posting `<!-- kata-review:* -->` comments |
| Correct | `/kata-pr-fix` | Triaged feedback, in-thread replies, re-run gates |

Generic agent-workflow depth (brainstorming, plan documents, subagent-driven
execution, code-review reception) is **not** reimplemented — it comes from the
`superpowers` plugin, enabled at project scope in `.claude/settings.json`. Each
skill names the sub-skill it defers to. On a fresh clone Claude Code resolves
it from the built-in `claude-plugins-official` marketplace; `claude plugin
list` shows whether it loaded.

This is Claude-Code-specific and deliberately absent from `AGENTS.md` — Codex
has no plugin system and must not be told to invoke these.
