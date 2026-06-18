#!/usr/bin/env bash
# Acceptance smoke tests for the Codex hooks. Drives each hook with
# the documented Codex stdin shape and asserts the documented
# behavior. No Codex CLI required — we simulate Codex by piping JSON.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PRE="$HERE/pre-tool-use.sh"
POST="$HERE/post-tool-use.sh"
STOP="$HERE/stop.sh"

fails=0
ran=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- helpers ----------------------------------------------------------

# expect_rc <expected> <name> <cmd-json>
# Pipes the JSON through pre-tool-use.sh and asserts the exit code.
expect_pre_rc() {
  local expected="$1" name="$2" json="$3"
  ran=$((ran + 1))
  local rc=0
  printf '%s' "$json" | bash "$PRE" >/dev/null 2>"$tmp/stderr" || rc=$?
  if [ "$rc" = "$expected" ]; then
    printf 'OK   %s (rc=%d)\n' "$name" "$rc"
  else
    fails=$((fails + 1))
    printf 'FAIL %s — expected rc=%s, got rc=%s\n  stderr: %s\n' \
      "$name" "$expected" "$rc" "$(cat "$tmp/stderr")"
  fi
}

expect_post_context_contains() {
  local needle="$1" name="$2" json="$3"
  ran=$((ran + 1))
  local out
  out="$(printf '%s' "$json" | bash "$POST" 2>/dev/null || true)"
  if printf '%s' "$out" | jq -er --arg n "$needle" '.hookSpecificOutput.additionalContext | contains($n)' >/dev/null 2>&1; then
    printf 'OK   %s\n' "$name"
  else
    fails=$((fails + 1))
    printf 'FAIL %s — additionalContext did not contain %q\n  out: %s\n' \
      "$name" "$needle" "$out"
  fi
}

expect_post_empty() {
  local name="$1" json="$2"
  ran=$((ran + 1))
  local out
  out="$(printf '%s' "$json" | bash "$POST" 2>/dev/null || true)"
  if [ -z "$out" ]; then
    printf 'OK   %s (silent exit)\n' "$name"
  else
    fails=$((fails + 1))
    printf 'FAIL %s — expected silent exit, got: %s\n' "$name" "$out"
  fi
}

# Asserts the Codex PostToolUse output both blocks (decision == "block")
# and surfaces <needle> in additionalContext — the shape `kata verify`
# violations take, mirroring the Claude wiring.
expect_post_block_contains() {
  local needle="$1" name="$2" json="$3"
  ran=$((ran + 1))
  local out
  out="$(printf '%s' "$json" | bash "$POST" 2>/dev/null || true)"
  if printf '%s' "$out" | jq -er --arg n "$needle" \
    '.decision == "block" and (.hookSpecificOutput.additionalContext | contains($n))' \
    >/dev/null 2>&1; then
    printf 'OK   %s\n' "$name"
  else
    fails=$((fails + 1))
    printf 'FAIL %s — expected decision=block + context containing %q\n  out: %s\n' \
      "$name" "$needle" "$out"
  fi
}

# --- R5.3 / R3.2: forbidden-command blocks ----------------------------

expect_pre_rc 2 'forbidden: git commit --no-verify' \
  '{"tool_input":{"command":"git commit --no-verify -m foo"}}'
expect_pre_rc 2 'forbidden: git commit -n' \
  '{"tool_input":{"command":"git commit -n -m foo"}}'
expect_pre_rc 2 'forbidden: git push --no-verify' \
  '{"tool_input":{"command":"git push --no-verify"}}'
expect_pre_rc 2 'forbidden: SKIP=lefthook' \
  '{"tool_input":{"command":"SKIP=lefthook git commit -m bar"}}'
expect_pre_rc 0 'allowed: git log -n 5 (not a commit)' \
  '{"tool_input":{"command":"git log -n 5"}}'
expect_pre_rc 0 'allowed: pnpm test (benign)' \
  '{"tool_input":{"command":"pnpm test"}}'

# --- R5.2 / R3.1: protected-file blocks -------------------------------

expect_pre_rc 2 'protected: biome.json (delegated)' \
  '{"tool_input":{"command":"echo {} > biome.json"}}'
expect_pre_rc 2 'protected: .codex/hooks.json (self-protect)' \
  '{"tool_input":{"command":"tee .codex/hooks.json <<EOF\n{}\nEOF"}}'
expect_pre_rc 2 'protected: .codex/hooks/post-tool-use.sh (self-protect)' \
  '{"tool_input":{"command":"sed -i s/x/y/ .codex/hooks/post-tool-use.sh"}}'
expect_pre_rc 2 'protected: .claude/settings.json (delegated)' \
  '{"tool_input":{"command":"cp /tmp/foo .claude/settings.json"}}'
expect_pre_rc 2 'protected: docs/adr/0008-foo.md (delegated)' \
  '{"tool_input":{"command":"echo new > docs/adr/0008-foo.md"}}'
expect_pre_rc 0 'allowed: write to src/foo.ts' \
  "{\"tool_input\":{\"command\":\"echo x > $tmp/foo.ts\"}}"

# --- R5.1 / R2.x: PostToolUse feedback injection ----------------------

# Bash command writes a real TS file inside the repo with an unfixable
# lint issue. Build a fixture under examples/hello/src/temp and trigger
# the Codex post-tool-use hook via a synthesized Bash `tee` payload.
fixture="$ROOT/examples/hello/src/__codex_hooks_fixture__.ts"
# A .route.ts inside a Kata app trips `kata verify` (kata/inline-schema).
kata_dir="$ROOT/examples/hello/src/modules/__codex_kata_fixture__"
kata_fixture="$kata_dir/__codex_kata_fixture__.route.ts"
trap 'rm -rf "$tmp" "$fixture" "$kata_dir"' EXIT
mkdir -p "$(dirname "$fixture")"

# Code that survives auto-fix but trips a lint rule (no-unused-vars).
cat >"$fixture" <<'EOF'
export const ok = () => {
  const unused = 'lint me'
  return 1
}
EOF

expect_post_context_contains "__codex_hooks_fixture__.ts" \
  'PostToolUse surfaces remaining lint violations' \
  "{\"tool_input\":{\"command\":\"echo touched > $fixture\"}}"

expect_post_empty 'PostToolUse silent on benign Bash (no writes)' \
  '{"tool_input":{"command":"pnpm typecheck"}}'

expect_post_empty 'PostToolUse silent on non-source write' \
  "{\"tool_input\":{\"command\":\"echo x > $tmp/notes.txt\"}}"

# kata verify parity: a route with an inline Zod schema must both inject
# the violation as feedback AND propagate decision:block, matching the
# Claude PostToolUse wiring (#124/#125).
mkdir -p "$kata_dir"
cat >"$kata_fixture" <<'EOF'
import { z } from 'zod'
import { defineRoute } from '../../context'

export const probeRoute = defineRoute({
  method: 'GET',
  path: '/codex-kata-fixture',
  input: { query: z.object({ q: z.string() }) },
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
})
EOF

expect_post_block_contains "kata/inline-schema" \
  'PostToolUse blocks + surfaces kata verify violations' \
  "{\"tool_input\":{\"command\":\"echo touched > $kata_fixture\"}}"

# --- R5.4: Stop hook short-circuits when stop_hook_active ------------

ran=$((ran + 1))
rc=0
out="$(echo '{"stop_hook_active":true}' | bash "$STOP" 2>&1)" || rc=$?
if [ "$rc" = 0 ] && [ -z "$out" ]; then
  printf 'OK   Stop hook short-circuits on stop_hook_active\n'
else
  fails=$((fails + 1))
  printf 'FAIL Stop hook short-circuit — rc=%s, out=%s\n' "$rc" "$out"
fi

printf '\n%d run, %d failed.\n' "$ran" "$fails"
exit "$fails"
