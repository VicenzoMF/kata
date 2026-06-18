#!/usr/bin/env bash
# Codex PostToolUse hook — mirror of .claude/hooks/post-tool-use.sh.
#
# Codex's Bash matcher gives us a `command` string, no file path. We
# parse the command for write targets and, for each one, hand off to
# the Claude PostToolUse script with a synthesized
# `tool_input.file_path` payload. The Claude script does the actual
# Biome+Oxlint+`kata verify` work and emits the JSON Codex expects.
#
# Two kinds of feedback flow back from the Claude script:
#   - lint/format violations  → `hookSpecificOutput.additionalContext`
#   - `kata verify` violations → the same context PLUS `decision: "block"`
#     and a one-line `reason` (see .claude/hooks/post-tool-use.sh phase 3
#     and packages/verify formatHookOutput).
#
# When the command writes multiple files we concatenate the messages
# into a single `additionalContext` so Codex sees them all in one turn,
# and if ANY file blocked we propagate `decision: "block"` with the
# blocking reasons — keeping behavioural parity with the Claude wiring.
# No paths detected → silent exit 0.

set -uo pipefail

ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
EXTRACT="$ROOT/.codex/hooks/lib/extract-write-paths.sh"
CLAUDE_HOOK="$ROOT/.claude/hooks/post-tool-use.sh"

input="$(cat)"
cmd="$(jq -r '.tool_input.command // empty' <<<"$input")"
[ -z "$cmd" ] && exit 0

paths="$("$EXTRACT" "$cmd")"
[ -z "$paths" ] && exit 0

combined=""
blocked=0
reasons=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  # Resolve to an absolute path if relative, so the Claude script's
  # `[ -f "$file" ]` check works regardless of cwd.
  case "$p" in
    /*) abs="$p" ;;
    *)  abs="$ROOT/$p" ;;
  esac

  payload="$(jq -nc --arg f "$abs" '{tool_input:{file_path:$f}}')"
  if out="$(printf '%s' "$payload" | bash "$CLAUDE_HOOK")"; then
    [ -z "$out" ] && continue
    ctx="$(jq -r '.hookSpecificOutput.additionalContext // empty' <<<"$out" 2>/dev/null || true)"
    [ -n "$ctx" ] && combined+="${combined:+$'\n\n'}$ctx"
    # Propagate `kata verify`'s block decision: if the delegated Claude
    # hook blocked on this file, the aggregate Codex result blocks too.
    if [ "$(jq -r '.decision // empty' <<<"$out" 2>/dev/null || true)" = "block" ]; then
      blocked=1
      r="$(jq -r '.reason // empty' <<<"$out" 2>/dev/null || true)"
      [ -n "$r" ] && reasons+="${reasons:+ }$r"
    fi
  fi
done <<<"$paths"

[ -z "$combined" ] && [ "$blocked" -eq 0 ] && exit 0

if [ "$blocked" -eq 1 ]; then
  jq -n --arg msg "$combined" --arg reason "$reasons" '{
    decision: "block",
    reason: $reason,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $msg
    }
  }'
  exit 0
fi

jq -n --arg msg "$combined" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
