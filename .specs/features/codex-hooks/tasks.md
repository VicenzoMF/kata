# Tasks: Codex hooks

Atomic, ordered, with verification per task.

---

## T1 — `extract-write-paths.sh` parser + test fixtures

**What:** New `.codex/hooks/lib/extract-write-paths.sh`. Reads a Bash
command string from `$1` (or stdin if `$1` empty), prints one path per
line to stdout. No deps beyond `bash`, `grep`, `sed`, `awk`.

**Where:** `.codex/hooks/lib/extract-write-paths.sh`

**Done when:**
- `extract-write-paths.sh 'echo foo > a.ts'` → `a.ts`
- `extract-write-paths.sh 'tee -a b.json <<EOF\nx\nEOF'` → `b.json`
- `extract-write-paths.sh 'sed -i s/x/y/ c.ts && cp d.ts e.ts'` → `c.ts\ne.ts`
- `extract-write-paths.sh 'cat a.ts'` → (empty)
- `extract-write-paths.sh 'rm a.ts'` → (empty)

**Reuses:** Nothing.

**Tests:** A shell-script test at `.codex/hooks/lib/extract-write-paths.test.sh`
that runs ~10 fixtures and exits non-zero on the first mismatch. Wired as a
package script later (T6).

**Gate:** `bash .codex/hooks/lib/extract-write-paths.test.sh` exits 0.

---

## T2 — `stop.sh` passthrough

**What:** Two-line script that `exec bash .claude/hooks/stop.sh "$@"`.
Codex's Stop payload fields (`stop_hook_active`) match what the Claude
script reads, so straight delegation works.

**Where:** `.codex/hooks/stop.sh`

**Done when:** `echo '{"stop_hook_active":true}' | bash .codex/hooks/stop.sh`
exits 0 with no output (the Claude script short-circuits on the
`stop_hook_active` field).

**Depends on:** Nothing.

**Reuses:** `.claude/hooks/stop.sh` (read-only delegation).

**Gate:** Manual smoke test above passes.

---

## T3 — `post-tool-use.sh` delegate

**What:** Reads Codex stdin, extracts `tool_input.command` with `jq`,
pipes the command through `extract-write-paths.sh`, and for each path
synthesizes `{"tool_input":{"file_path":"<path>"}}` to feed
`.claude/hooks/post-tool-use.sh`. If multiple paths, concatenates their
`additionalContext` outputs into a single JSON output. Silent exit 0 when
no paths are produced.

**Where:** `.codex/hooks/post-tool-use.sh`

**Done when:**
- Bash command writing `a.ts` triggers Biome+Oxlint as if a Claude
  Write had fired on `a.ts`.
- Bash command with no detectable write produces exit 0 + no output.
- A command that writes two `.ts` files produces a single combined
  `additionalContext` mentioning both.

**Depends on:** T1.

**Reuses:** `.claude/hooks/post-tool-use.sh`.

**Gate:** Manual: `echo '{"tool_input":{"command":"echo x > /tmp/a.ts"}}'
| bash .codex/hooks/post-tool-use.sh` exits 0 (path outside repo, parser
emits, Claude script short-circuits on non-existent file). And the same
with a real `.ts` file in the repo produces an `additionalContext` block.

---

## T4 — `pre-tool-use.sh` delegate + forbidden-command block

**What:**
1. Read stdin, get `tool_input.command`.
2. If command matches a forbidden pattern (`--no-verify`, ` -n ` after
   `git commit`, `SKIP=...`), exit 2 with an ADR-anchored stderr.
3. Otherwise, for each path produced by `extract-write-paths.sh`,
   synthesize `{"tool_input":{"file_path":"<path>"}}` and invoke
   `.claude/hooks/pre-tool-use.sh`. If that returns exit 2, propagate
   stderr and exit 2.
4. Exit 0 if no path triggers a block.

**Where:** `.codex/hooks/pre-tool-use.sh`

**Done when:**
- `git commit --no-verify` command → exit 2, stderr mentions the rule.
- `SKIP=lefthook git commit` → exit 2.
- A command writing `biome.json` → exit 2 (delegated block).
- A command writing `.codex/hooks/post-tool-use.sh` → exit 2 (after T5).
- A benign command (`pnpm test`) → exit 0, no output.

**Depends on:** T1, T5.

**Reuses:** `.claude/hooks/pre-tool-use.sh`.

**Gate:** Inline smoke tests in the script's test fixture (T7).

---

## T5 — Self-protect `.codex/` from inside the Codex hook

**What:** Inline path-protection check in `.codex/hooks/pre-tool-use.sh`
that fires BEFORE delegating to the Claude script. Blocks any write
extracted by the parser that targets `.codex/hooks.json` or
`.codex/hooks/*`. The Claude script is not edited (editing
`.claude/hooks/*` is itself blocked by our own PreToolUse — a follow-up
issue can mirror `.codex/` protection on the Claude side via a non-agent
edit).

**Where:** Inside `.codex/hooks/pre-tool-use.sh` (one extra `case` arm
before the delegation loop).

**Done when:** A Codex Bash command that writes `.codex/hooks.json` is
blocked with an ADR-anchored stderr.

**Depends on:** Folded into T4.

**Reuses:** Nothing.

**Gate:** Covered by T4's fixture.

---

## T6 — `.codex/hooks.json` config

**What:** Wire the three scripts to the three events, with `Bash` as the
primary matcher and `apply_patch` listed as best-effort.

**Where:** `.codex/hooks.json`

**Done when:** File validates as JSON, all three events present, all
three matchers list at least `Bash`, all commands reference scripts that
exist.

**Depends on:** T2, T3, T4.

**Reuses:** Nothing.

**Gate:** `jq . .codex/hooks.json` exits 0; `test -x .codex/hooks/*.sh`
true for each script.

---

## T7 — Acceptance smoke test script

**What:** `.codex/hooks/acceptance.test.sh` — drives each hook with a
fixture stdin and asserts the documented behavior (R5.1–R5.4). Runs as a
shell test, no Codex CLI required (we simulate Codex by piping the
documented stdin shape).

**Where:** `.codex/hooks/acceptance.test.sh`

**Done when:** Script exits 0 and prints one `OK: <case>` per
acceptance criterion.

**Depends on:** T1–T6.

**Reuses:** All scripts under `.codex/hooks/`.

**Gate:** `bash .codex/hooks/acceptance.test.sh` exits 0.

---

## T8 — Wire shell tests into pnpm

**What:** Add a `test:hooks` script to root `package.json` that runs
`bash .codex/hooks/lib/extract-write-paths.test.sh && bash
.codex/hooks/acceptance.test.sh`. Optional: chain it from `pnpm test`.

**Where:** root `package.json`

**Done when:** `pnpm test:hooks` exits 0. (Decide on chaining from
`pnpm test` during execution — if it slows CI noticeably, keep separate.)

**Depends on:** T1, T7.

**Reuses:** existing test scripts.

**Gate:** `pnpm test:hooks` green.

---

## T9 — Verify + commit + PR

**What:** Run `pnpm typecheck`, `pnpm test`, `pnpm test:hooks`. Commit
on `feat/codex-hooks`, open PR linked to #44.

**Done when:** PR opened with description referencing R5.1–R5.4 and
quoting the acceptance criterion verbatim.

**Depends on:** T1–T8.

**Gate:** Lefthook pre-commit passes; PR exists.

---

## Parallelism

T1, T2, T5 are independent and can run in parallel if a sub-agent is
delegated per task. T3/T4 depend on T1. T6 depends on T2/T3/T4. T7/T8/T9
are sequential gates.

For this small set, we execute sequentially in the main agent — the
delegation overhead outweighs the parallelism win on ~9 small shell
files.
