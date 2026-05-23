#!/usr/bin/env bash
# Claude Code Stop hook — "done" is mechanically verified.
#
# Runs the minute-scale verification ladder before the agent is allowed to
# terminate the session:
#
#   1. pnpm typecheck   — type errors
#   2. pnpm test        — vitest (unit + integration)
#   3. hurl             — E2E against examples/hello (server spawned here)
#
# On failure, returns `{"decision":"block","reason": <captured output>}` so
# Claude Code re-enters the loop with the failing output as context, per
# the article's "feedback injection" pattern.
#
# Honors `stop_hook_active`: if Claude is already iterating because of us,
# exit 0 so we don't ping-pong past the 8-block cap.
#
# Required CLI: hurl (system pkg). Missing hurl is treated as a hard block
# with an install hint — agents should not declare done with no E2E layer.

set -uo pipefail

input="$(cat)"

if [ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ]; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

block() {
  jq -Rn --arg reason "$1" '{decision: "block", reason: $reason}'
  exit 0
}

run_step() {
  local label="$1"; shift
  local out
  if ! out="$("$@" 2>&1)"; then
    block "kata harness — $label failed. Fix before stopping.

\$ $*

$out"
  fi
}

run_step "pnpm typecheck" pnpm typecheck
run_step "pnpm test" pnpm test

if ! command -v hurl >/dev/null 2>&1; then
  block "kata harness — hurl CLI not installed. Install with one of:
  apt install hurl   #  Debian/Ubuntu
  brew install hurl  #  macOS
  cargo install hurl #  any platform

E2E verification cannot be skipped; install hurl and try again."
fi

# Pick a free port so a dev server on :3000 doesn't collide.
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')"
HURL_SRC="examples/hello/src/modules/users/users.hurl"
HURL_TMP="$(mktemp --suffix=.hurl)"
SERVER_LOG="$(mktemp)"
sed "s|localhost:3000|localhost:$PORT|g" "$HURL_SRC" >"$HURL_TMP"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$HURL_TMP" "$SERVER_LOG"
}
trap cleanup EXIT

PORT="$PORT" pnpm --silent --filter=hello start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait up to 10s for the server to accept connections.
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://localhost:$PORT/users/none" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    block "kata harness — examples/hello failed to start:

$(cat "$SERVER_LOG")"
  fi
  sleep 0.2
done

if ! curl -s -o /dev/null "http://localhost:$PORT/users/none" >/dev/null 2>&1; then
  block "kata harness — examples/hello did not become ready on :$PORT within 10s.

server log:
$(cat "$SERVER_LOG")"
fi

if ! hurl_out="$(hurl --test --color "$HURL_TMP" 2>&1)"; then
  block "kata harness — hurl E2E failed. Fix before stopping.

\$ hurl --test $HURL_SRC  (rewritten to port $PORT)

$hurl_out

server log:
$(cat "$SERVER_LOG")"
fi

exit 0
