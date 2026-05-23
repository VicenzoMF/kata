# Feature: Codex hooks (mirror of Claude harness)

**Issue:** #44 — `.codex/hooks.json` equivalent (Bash matcher)
**Epic:** #37 — Self-applied harness engineering
**Milestone:** v0.0 — Self-applied harness

## Problem

The Kata harness today only covers Claude Code sessions. The repo lays out
three Claude hooks under `.claude/hooks/` (PostToolUse auto-fix, PreToolUse
config protection, Stop verification ladder). Issue #44 names "hybrid: plan
with Claude Code, execute with Codex" as the workflow we want to support —
and a Codex session that edits files today bypasses every harness layer
except CI (L3), losing the millisecond and minute feedback loops the
article calls out as load-bearing.

## Goal

Ship a project-local `.codex/` configuration that gives a Codex CLI session
the same harness coverage a Claude Code session gets today: silent
auto-fix on file edits, blocked edits to protected configs / ADRs, banned
`--no-verify` shortcuts, and a typecheck/test/E2E gate before the session
can declare itself "done".

## Non-goals

- Refactoring `.claude/hooks/*` into shared libraries. The PreToolUse hook
  protects `.claude/hooks/*` for good reason (ADR-0007); reshaping those
  scripts is out of scope and would require disabling our own harness to
  do.
- Adding a `UserPromptSubmit` hook. The issue lists it as one of the four
  Codex hook events to "mirror", but Claude has no UserPromptSubmit hook
  configured today. Mirror = parity, so we mirror the three hooks that
  actually exist. (Re-open if Claude later adds one.)
- Supporting `apply_patch` reliably. The Codex docs flag `apply_patch`
  matching as "intermittent coverage"; we register the matcher anyway so
  it works when Codex fires it, but the contract is Bash-based.

## Requirements

### R1 — Config location & shape (load-bearing)

R1.1. Hooks ship under `.codex/hooks.json` at the repo root (project-local
load source documented by Codex; loads when the project's `.codex/` layer
is trusted).

R1.2. The file conforms to the documented Codex schema:
`{"hooks":{"<EventName>":[{"matcher":"...","hooks":[{"type":"command","command":"..."}]}]}}`.

R1.3. Scripts live under `.codex/hooks/*.sh`, invoked with `bash
$CODEX_PROJECT_DIR/.codex/hooks/<name>.sh` (or equivalent — see R1.4).

R1.4. If `$CODEX_PROJECT_DIR` is not provided by Codex, the script must
fall back to `git rev-parse --show-toplevel` so the hook works from any
cwd.

### R2 — PostToolUse parity (millisecond layer)

R2.1. After a Codex Bash call that writes a `.ts|.tsx|.js|.jsx|.json` file,
run Biome `--write` and (for JS/TS) Oxlint `--fix` silently against that
file. Same behavior as `.claude/hooks/post-tool-use.sh`.

R2.2. Remaining lint violations after auto-fix are surfaced to Codex via
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`
on stdout (Codex's documented schema, identical to Claude's).

R2.3. Files that are not lint/format targets must produce a silent exit 0
(no output), so the agent flow is not interrupted on non-source writes.

R2.4. The matcher MUST cover `Bash` and SHOULD also list `apply_patch`
(best-effort, since Codex flags its coverage as intermittent).

### R3 — PreToolUse parity (rule-tampering closure)

R3.1. Block Bash commands whose effect would write to any of the protected
paths the Claude PreToolUse hook already protects: `biome.json`,
`.oxlintrc*`, `tsconfig*.json`, `lefthook.yml`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.github/workflows/*.yml`, `docs/adr/*.md`,
`.claude/settings.json`, `.claude/hooks/*`, **and now `.codex/hooks.json`
and `.codex/hooks/*`** (the harness must protect its own Codex layer too).

R3.2. Block forbidden command shortcuts that today live in Claude's
`permissions.deny` list (which Codex does not have an equivalent for):
`git commit ... --no-verify`, `git commit ... -n`, `git push
... --no-verify`, and any command prefixed with `SKIP=...`.

R3.3. Blocks emit exit code 2 with an ADR-anchored stderr explanation —
matching the article's "make the rule and the reason both visible to the
agent" pattern that Claude's pre-tool-use.sh already uses.

R3.4. File-touch detection from the Bash command string covers, at
minimum: redirects (`>`, `>>`), `tee`/`tee -a`, `sed -i ...`, `cp <src>
<dst>`, `mv <src> <dst>`, `touch`, heredocs (`cat >file <<EOF ...`),
`printf ... > file`, `echo ... > file`. Programmatic writes from
sub-interpreters (e.g. `python -c "open(...).write(...)"`) are out of
scope and documented as such.

### R4 — Stop parity (minute layer)

R4.1. Before a Codex session terminates, run the same verification ladder
the Claude Stop hook runs: `pnpm typecheck`, `pnpm test`, hurl E2E against
`examples/hello`.

R4.2. On failure, emit `{"decision":"block","reason":"..."}` so Codex
re-enters the loop with the failing output as context (Codex's
documented continuation format, identical to Claude's).

R4.3. Honor Codex's `stop_hook_active` field exactly as the Claude hook
does, to avoid past-the-cap ping-ponging.

R4.4. Implementation MUST NOT duplicate the verification logic from
`.claude/hooks/stop.sh` — the Codex script delegates to the same logic.
(The Codex Stop payload is field-compatible with the Claude one for the
fields the script reads, so we can `exec` the Claude script directly. See
design.md.)

### R5 — Acceptance (issue #44, verbatim)

R5.1. Running a Codex task that edits a source file (via a Bash command
that writes one) triggers the same format / lint feedback Claude gets on
Write/Edit (R2).

R5.2. A Codex Bash command that would edit a protected config file is
blocked with an ADR-anchored message before it executes (R3.1, R3.3).

R5.3. A Codex Bash command containing `--no-verify` or `SKIP=...` is
blocked before it executes (R3.2, R3.3).

R5.4. A Codex session that ends with a failing typecheck / test / hurl is
re-prompted with the failing output via the `decision: block` schema
(R4.2). A green ladder allows the session to end (exit 0).

## Out-of-scope / deferred

- ADR codifying `.codex/` as a peer of `.claude/` for harness wiring.
  Worth a follow-up ADR once this lands and we've used it once or twice.
- A `kata init` template that generates `.codex/` for downstream projects
  (issue #28 owns that — this issue ships the reference implementation
  that #28 will template from).
