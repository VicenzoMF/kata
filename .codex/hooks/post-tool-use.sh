#!/usr/bin/env bash
# Codex PostToolUse hook — mirror of .claude/hooks/post-tool-use.sh.
#
# Codex's Bash matcher gives us a `command` string, no file path. We
# parse the command for write targets and, for each one, hand off to
# the Claude PostToolUse script with a synthesized
# `tool_input.file_path` payload. The Claude script does the actual
# Biome+Oxlint work and emits the `hookSpecificOutput.additionalContext`
# JSON Codex expects.
#
# When the command writes multiple files we concatenate the messages
# into a single `additionalContext` so Codex sees them all in one
# turn. No paths detected → silent exit 0.

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
    ctx="$(jq -r '.hookSpecificOutput.additionalContext // empty' <<<"$out" 2>/dev/null || true)"
    [ -n "$ctx" ] && combined+="${combined:+$'\n\n'}$ctx"
  fi
done <<<"$paths"

[ -z "$combined" ] && exit 0

jq -Rn --arg msg "$combined" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
