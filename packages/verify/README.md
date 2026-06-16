# @kata/verify

Fast, deterministic lint checks for [Kata](../../README.md) projects. `kata
verify` globs a project's source, AST-matches Kata's conventions, and reports
violations with an agent-actionable **ERROR / WHY / FIX / EXAMPLE** message —
either as a human-readable report or as JSON for a Claude Code PostToolUse hook.

## Usage

```sh
kata verify [path]          # human-readable report (exit 1 on any error)
kata verify [path] --json   # PostToolUse hook JSON on stdout (always exit 0)
kata verify [path] --watch  # re-check on every file change (Ctrl-C to stop)
kata verify --help
```

`path` defaults to the current working directory. The project is expected to
follow the mandatory folder layout (`src/context.ts`, `src/modules/**/*.route.ts`).

This package is the rule engine; the user-facing command is **`kata verify`**,
shipped by the `kata` bin which bundles this package (so downstream `kata init`
apps get it for free). From the workspace:

```sh
pnpm exec kata verify examples/hello              # via the kata bin (built)
pnpm --filter=@kata/verify run verify -- ../../examples/hello   # via tsx (dev, no build)
```

## Rules

| Rule | ADR | What it catches |
|---|---|---|
| `kata/no-route-without-output-schema` | [0003](../../docs/adr/0003-mandatory-input-output-schemas.md) | a `defineRoute({ … })` in a `*.route.ts` with no `output` schema |
| `kata/no-route-without-input-schema` | [0003](../../docs/adr/0003-mandatory-input-output-schemas.md) | a `defineRoute({ … })` with no `input` field (an empty `input: {}` is fine) |
| `kata/inline-schema` | [0005](../../docs/adr/0005-dtos-in-separate-schema-file.md) | a Zod schema built inline (`z.object(…)`) in a `*.route.ts` / `*.service.ts` instead of a `*.schema.ts` |
| `kata/scoped-slot-not-provided` | [0004](../../docs/adr/0004-di-via-scoped-slots.md) | a handler reading `c.get('slot')` for a scoped slot with no providing middleware in its `use:` chain |
| `kata/middleware-provides-mismatch` | [0004](../../docs/adr/0004-di-via-scoped-slots.md) | a `defineMiddleware` whose `provides: ['x']` lists a slot its handler never `c.set`s |
| `kata/context-key-not-registered` | [0004](../../docs/adr/0004-di-via-scoped-slots.md) | `c.get('key')` where `'key'` is not declared in `defineContext({ … })` |

Every rule is intentionally conservative: any construct it cannot statically
prove (a spread config, a dynamic `c.get`/`c.set` key, an indeterminate registry,
or an unresolvable `use:` entry) is left alone, so the false-positive rate stays
at zero on conforming code.

## Watch mode

`kata verify --watch` keeps the process alive and re-checks on every change under
`src/`. Only the file that changed is re-read; the rest of the project is held in
memory, so the rebuilt report stays fast even though cross-file rules (the
registry, scoped-slot, and provides checks) re-evaluate the whole project.

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
