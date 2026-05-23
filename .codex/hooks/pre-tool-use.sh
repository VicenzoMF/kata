#!/usr/bin/env bash
# Codex PreToolUse hook — mirror of .claude/hooks/pre-tool-use.sh,
# plus the `permissions.deny` command list Claude enforces in
# settings.json (Codex has no equivalent slot, so it lives here).
#
# Two responsibilities, in order:
#   1. Match forbidden command patterns (`--no-verify`, `SKIP=...`,
#      `git commit -n`). Hard block via exit 2 with stderr.
#   2. Extract write paths from the command and, for each one, ask
#      the Claude PreToolUse hook whether it would block. If any path
#      gets blocked, propagate the exit 2 and the Claude script's
#      stderr.
#
# Also self-protects `.codex/hooks.json` and `.codex/hooks/*` inline,
# since editing the Claude pre-tool-use script to add them is itself
# blocked by the Claude pre-tool-use script (chicken-and-egg). The
# Claude-side symmetric protection of .codex/ is a follow-up issue.
#
# Exit codes follow the Codex spec: 2 blocks the tool call and surfaces
# stderr to the agent; 0 allows it.

set -uo pipefail

ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
EXTRACT="$ROOT/.codex/hooks/lib/extract-write-paths.sh"
CLAUDE_HOOK="$ROOT/.claude/hooks/pre-tool-use.sh"

input="$(cat)"
cmd="$(jq -r '.tool_input.command // empty' <<<"$input")"
[ -z "$cmd" ] && exit 0

# ── 1. Forbidden command shortcuts ──────────────────────────────────
# Same patterns Claude's settings.json `permissions.deny` enforces.
block_cmd() {
  cat >&2 <<EOF
kata harness — forbidden command blocked
[$1]
WHY: $2 — this is one of the article's named "cheat paths". The
harness fails closed on shortcuts that bypass commit-time and CI
verification (ADR-0007).
FIX: run the command without the bypass flag, fix what the hook
or check is reporting, then commit normally.
EOF
  exit 2
}

has_git_commit=0
has_git_push=0
[[ "$cmd" =~ (^|[[:space:]\;\&\|])git[[:space:]]+commit([[:space:]]|$) ]] && has_git_commit=1
[[ "$cmd" =~ (^|[[:space:]\;\&\|])git[[:space:]]+push([[:space:]]|$) ]]   && has_git_push=1

if [ "$has_git_commit" = 1 ] && [[ "$cmd" == *--no-verify* ]]; then
  block_cmd "$cmd" "git commit --no-verify skips Lefthook (format/lint/typecheck)"
fi
if [ "$has_git_commit" = 1 ] && [[ "$cmd" =~ [[:space:]]-n([[:space:]]|$) ]]; then
  block_cmd "$cmd" "git commit -n is the short form of --no-verify"
fi
if [ "$has_git_push" = 1 ] && [[ "$cmd" == *--no-verify* ]]; then
  block_cmd "$cmd" "git push --no-verify skips the pre-push hook"
fi
if [[ "$cmd" =~ (^|[[:space:]\;\&\|])SKIP= ]]; then
  block_cmd "$cmd" "SKIP=<hook> is Lefthook's bypass env var"
fi

# ── 2. Per-path delegation to the Claude pre-tool-use script ────────
paths="$("$EXTRACT" "$cmd")"
[ -z "$paths" ] && exit 0

block_codex_self() {
  cat >&2 <<EOF
kata harness — edit to protected Codex hook blocked
[$1]
WHY: $2. ADR-0007 (self-applied harness) says rule-tampering is the
agent's cheapest cheat path; the Codex hooks protect themselves.
FIX: do not edit the harness config to silence a check. Fix the
underlying code. If the rule itself is wrong, open a PR from a
non-agent shell.
EOF
  exit 2
}

while IFS= read -r p; do
  [ -z "$p" ] && continue
  case "$p" in
    /*) abs="$p" ;;
    *)  abs="$ROOT/$p" ;;
  esac

  rel="${abs#"$ROOT"/}"

  # Inline Codex self-protection (Claude script doesn't list these yet).
  case "$rel" in
    .codex/hooks.json)
      block_codex_self "$rel" ".codex/hooks.json wires this hook" ;;
    .codex/hooks/*)
      block_codex_self "$rel" "hook scripts define the guardrails — edits would let the agent rewrite its own rules" ;;
  esac

  # Delegate the rest to the Claude script. It already knows about
  # biome/oxlint/tsconfig/lefthook/lockfile/workflows/ADRs/.claude.
  payload="$(jq -nc --arg f "$abs" '{tool_input:{file_path:$f}}')"
  if claude_err="$(printf '%s' "$payload" | bash "$CLAUDE_HOOK" 2>&1 >/dev/null)"; then
    : # exit 0 from Claude script — this path is allowed.
  else
    rc=$?
    if [ "$rc" -eq 2 ]; then
      printf '%s\n' "$claude_err" >&2
      exit 2
    fi
    # Any other non-zero from the Claude script is a hook bug, not an
    # intentional block. Surface it but don't pretend to block.
    printf 'kata harness — Codex pre-tool-use delegation: Claude script exited %d\n%s\n' \
      "$rc" "$claude_err" >&2
  fi
done <<<"$paths"

exit 0
