# Design: Codex hooks

## Decision 1 — Code reuse: thin Codex wrappers that delegate to Claude scripts

The Claude hook scripts already implement the verification ladder, the
config-protection list, and the lint-feedback injection. Duplicating them
under `.codex/hooks/*` would create two sources of truth that drift the
moment one is touched.

Three options were considered:

| Option | Description | Verdict |
|---|---|---|
| A — Thin wrapper | Codex script parses its payload, builds a Claude-shaped payload, pipes it to the existing Claude script | **Chosen** |
| B — Self-contained duplicate | Each Codex script reimplements the Claude logic | Drift risk |
| C — Extract shared lib | Move logic to `harness/lib/*.sh`, both Claude and Codex call it | Requires editing `.claude/hooks/*`, which our own PreToolUse blocks (ADR-0007). Out of scope. |

We pick **A**. Each Codex script reads its own stdin, translates fields,
and `exec`s the corresponding Claude script with the rewritten payload on
stdin. The output schemas are identical (Codex documents the same
`hookSpecificOutput.additionalContext` shape and the same
`decision: block` schema), so pass-through works without re-serializing.

For the Stop hook, the input fields the Claude script reads
(`stop_hook_active`) are also present in the Codex payload under the same
name — so we just `exec` it directly with no translation. Stop becomes a
two-line forwarder.

## Decision 2 — Bash command parser scope

The Codex Pre/PostToolUse Bash matcher gives us a `command` string and no
file path. We need a parser that extracts "which paths would this command
write to" — good enough for the harness's purpose (catching the cheap
paths, not building a sound static analyzer).

Heuristics, in priority order, applied to the raw command string:

1. **Tokenization**: split on shell metacharacters that introduce a new
   command (`;`, `&&`, `||`, `|`) and process each segment independently.
   Heredocs and quoted strings are NOT parsed — we don't try to be a
   shell; if a write hides inside a quoted heredoc the harness misses it
   (false negative). The article calls this out as acceptable: cheating
   via "escape a forbidden write inside a quoted heredoc" is not a path
   an agent stumbles into.
2. Per segment, match against these patterns and emit zero or more file
   paths:
   - `tee [-a|--append]? <file>` → `<file>`
   - `sed -i [-e ...]* <file>` → `<file>`
   - `cp <src> <dst>` → `<dst>` (last positional after flags)
   - `mv <src> <dst>` → `<dst>`
   - `touch <file...>` → each positional
   - `cat <file>` (read-only) → nothing
   - **Trailing redirects** anywhere in the segment: `> <file>`, `>> <file>`,
     `>| <file>`, `&> <file>`, `2> <file>` → `<file>`. These are
     command-agnostic — they fire for any program (`echo`, `printf`, `node
     foo.js`, anything-with-redirect).
3. Output: newline-delimited list of paths, deduplicated, with relative
   paths normalized via `realpath --relative-to="$ROOT"` so the
   downstream Claude script's path matchers (`case "$rel" in ...`) work.

The parser lives at `.codex/hooks/lib/extract-write-paths.sh`. It is the
only piece of net-new logic; everything else is delegation.

## Decision 3 — Forbidden command blocking lives in PreToolUse

Codex has no `permissions.deny` array. The Claude harness today denies
four prefixes (`git commit *--no-verify*`, `git commit *-n *`, `git push
*--no-verify*`, `SKIP=*`). For Codex we move that responsibility into the
PreToolUse hook itself: the hook inspects the raw command string and
exit-2's with a stderr explaining the rule, before delegating the
file-protection check.

Same patterns as the Claude `permissions.deny` list:
- `\bgit\s+commit\b.*--no-verify\b`
- `\bgit\s+commit\b.*\s-n\b`
- `\bgit\s+push\b.*--no-verify\b`
- `^\s*SKIP=`

This makes the Codex PreToolUse hook the union of:
1. Forbidden-command match (immediate block, no delegation)
2. For each path extracted by the parser → invoke Claude pre-tool-use.sh
   with a synthesized `{"tool_input":{"file_path":"<path>"}}` payload; if
   the Claude script exits 2, propagate the exit code and stderr to Codex.

## Decision 4 — Self-protection: `.codex/` also gets protected

Once we ship a Codex harness, `.codex/hooks.json` and `.codex/hooks/*` are
themselves rule-tampering targets. We add them to the Claude PreToolUse
protected list AS PART OF this issue (this is the one edit to a `.claude/`
file we have to make, and it's the minimum necessary). The protection is
symmetric: `.claude/*` and `.codex/*` both blocked from both harnesses.

## Component layout

```
.codex/
├── hooks.json                      # config — wires the events to scripts
└── hooks/
    ├── lib/
    │   └── extract-write-paths.sh  # bash command → paths (only new logic)
    ├── pre-tool-use.sh             # forbidden-cmd block + per-path delegate
    ├── post-tool-use.sh            # per-path delegate to Claude post-tool-use
    └── stop.sh                     # exec .claude/hooks/stop.sh (passthrough)
```

## Sequence — PostToolUse on a Bash command that writes `users.service.ts`

```
Codex                       .codex/hooks/post-tool-use.sh   .claude/hooks/post-tool-use.sh
  │                                  │                                  │
  │── Bash tool fires ──────────────►│                                  │
  │  {tool_input.command:            │                                  │
  │   "tee src/users.service.ts <<EOF ... EOF"} │                       │
  │                                  │                                  │
  │                          ┌───────┴────────┐                         │
  │                          │ extract-write- │                         │
  │                          │ paths.sh       │                         │
  │                          │ → src/users.service.ts                   │
  │                          └───────┬────────┘                         │
  │                                  │                                  │
  │                                  │── exec with                      │
  │                                  │  {tool_input.file_path:          │
  │                                  │   "src/users.service.ts"} ──────►│
  │                                  │                                  │
  │                                  │                        ┌─────────┴────────┐
  │                                  │                        │ biome --write    │
  │                                  │                        │ oxlint --fix     │
  │                                  │                        │ collect remaining│
  │                                  │                        └─────────┬────────┘
  │                                  │                                  │
  │◄── hookSpecificOutput.additionalContext on stdout ──── (passthrough) │
```

## Risks & follow-ups

- **Parser false negatives.** A command that writes via a sub-interpreter
  (`python -c "open('x','w')"`) or a script-of-a-script
  (`bash -c 'tee x'`) escapes the parser. Acceptable for v0.0; an agent
  that reaches for those forms to bypass the harness is doing something
  the article calls out as "explicit cheating," and CI (L3) catches it
  anyway.
- **`apply_patch` flakiness.** Codex docs say coverage is intermittent. We
  list it as a matcher so it works when fired, but the Bash matcher is
  the contract.
- **Stop hook spawns a server.** The Claude stop.sh spawns `examples/hello`
  on a random port. Codex inheriting the same script inherits the same
  behavior — verified to work in #42's PR. No additional work.
