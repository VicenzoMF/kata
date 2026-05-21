#!/usr/bin/env bash
# Claude Code PostToolUse hook — millisecond feedback layer of the v0.0 MVH.
#
# Phase 1: silent auto-fix (Biome format + Oxlint --fix).
# Phase 2: surface remaining lint violations as
#          hookSpecificOutput.additionalContext so Claude self-corrects on
#          the next turn (article: "feedback injection drives the fix forward").
#
# Invoked by Claude Code on Write|Edit|MultiEdit. Skips non-source files
# silently (exit 0 with no output) so the agent's flow stays unblocked.

set -euo pipefail

input="$(cat)"
file="$(jq -r '.tool_input.file_path // .tool_input.path // empty' <<<"$input")"

# Bail silently for paths we don't lint/format.
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.json) ;;
  *) exit 0 ;;
esac

# File may have been deleted by a MultiEdit / Write that removes content.
[ -f "$file" ] || exit 0

# Run from repo root so workspace bin resolution works regardless of cwd.
ROOT="$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Phase 1 — silent auto-fix. Failures are swallowed; remaining violations
# surface in phase 2 anyway. `--no-errors-on-unmatched` makes Biome quiet
# when the file is excluded by its own globs.
pnpm exec biome check --write --no-errors-on-unmatched "$file" >/dev/null 2>&1 || true
case "$file" in
  *.ts | *.tsx | *.js | *.jsx)
    pnpm exec oxlint --fix "$file" >/dev/null 2>&1 || true
    ;;
esac

# Phase 2 — collect violations the auto-fix could not resolve.
remaining=""
case "$file" in
  *.ts | *.tsx | *.js | *.jsx)
    # Oxlint emits `path:line:col: severity rule: message` per finding.
    remaining="$(pnpm exec oxlint "$file" 2>&1 | grep -E ":[0-9]+:[0-9]+:" || true)"
    ;;
esac

if [ -z "$remaining" ]; then
  exit 0
fi

msg="kata harness — remaining violations in $file:

$remaining

Fix these before the next edit. The harness will re-run on every Write/Edit/MultiEdit."

jq -Rn --arg msg "$msg" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
