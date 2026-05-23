#!/usr/bin/env bash
# Codex Stop hook — delegates to the Claude Stop script.
#
# Codex's Stop payload uses the same field names the Claude script
# reads (`stop_hook_active`) and accepts the same output shape
# (`{"decision":"block","reason":"..."}`), so we straight-`exec` the
# Claude script with our stdin. Keeping one source of truth for the
# verification ladder avoids the drift we'd get from duplicating it
# under .codex/.

set -euo pipefail

ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
exec bash "$ROOT/.claude/hooks/stop.sh" "$@"
