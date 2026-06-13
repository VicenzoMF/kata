# @kata/verify

Fast, deterministic lint checks for [Kata](../../README.md) projects. `kata
verify` globs a project's source, AST-matches Kata's conventions, and reports
violations with an agent-actionable **ERROR / WHY / FIX / EXAMPLE** message —
either as a human-readable report or as JSON for a Claude Code PostToolUse hook.

## Usage

```sh
kata verify [path]          # human-readable report (exit 1 on any error)
kata verify [path] --json   # PostToolUse hook JSON on stdout (always exit 0)
kata verify --help
```

`path` defaults to the current working directory. The project is expected to
follow the mandatory folder layout (`src/context.ts`, `src/modules/**/*.route.ts`).

From the workspace:

```sh
pnpm --filter=@kata/verify run verify          # check the package itself (no-op)
pnpm --filter=@kata/verify exec kata-verify ../../examples/hello
```

## Rules

| Rule | ADR | What it catches |
|---|---|---|
| `kata/no-route-without-output-schema` | [0003](../../docs/adr/0003-mandatory-input-output-schemas.md) | a `defineRoute({ … })` in a `*.route.ts` with no `output` schema |
| `kata/context-key-not-registered` | [0004](../../docs/adr/0004-di-via-scoped-slots.md) | `c.get('key')` where `'key'` is not declared in `defineContext({ … })` |

Both rules are intentionally conservative: any construct they cannot statically
prove (a spread config, a dynamic `c.get` key, an indeterminate registry) is
left alone, so the false-positive rate stays at zero on conforming code.

## Hook integration

`kata verify --json` prints the shape a [PostToolUse
hook](https://code.claude.com/docs/en/hooks) consumes. On violations it injects
the full report as `hookSpecificOutput.additionalContext` and sets `decision:
"block"` so the agent fixes the issue before continuing; on a clean run it prints
`{}`. Wire it into `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "kata verify --json" }] }
    ]
  }
}
```
