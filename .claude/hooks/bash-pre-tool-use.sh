#!/usr/bin/env bash
set -euo pipefail

input="$(cat)"
command="$(jq -r '.tool_input.command // empty' <<<"$input")"
[ -z "$command" ] && exit 0

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

while IFS= read -r path; do
  [ -z "$path" ] && continue
  
  mock_input=$(jq -n --arg p "$path" '{tool_input: {path: $p}}')
  
  if ! echo "$mock_input" | bash "$ROOT/.claude/hooks/pre-tool-use.sh"; then
     exit 2
  fi
done < <(echo "$command" | bash "$ROOT/.codex/hooks/lib/extract-write-paths.sh")

exit 0
