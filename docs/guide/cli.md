---
title: Bootstrap CLI
description: kata init scaffolds a harness-wired project — Claude/Codex hooks, agent instructions, and an optional runnable GET /health app. Idempotent by default.
---

# Bootstrap CLI

Kata ships one binary, `kata`. It has exactly one command: `init`. Run it inside
a project to write the harness — the Claude Code and Codex hook configs plus the
`AGENTS.md` / `CLAUDE.md` instruction pair. Add `--with-example` and it also
scaffolds a runnable `GET /health` app you can boot in one more step.

The CLI does not install anything, manage versions, or generate per-route code.
It writes a fixed set of files, idempotently, and reports what it did.

## `kata init`

```bash
kata init
```

Writes the four harness files into the current directory:

```
kata init → /path/to/project
  create  .claude/settings.json
  create  .codex/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
```

| File | What it is |
|---|---|
| `.claude/settings.json` | Claude Code hooks (PreToolUse / PostToolUse / Stop) plus a `permissions.deny` list that bans config tampering and commit/push verification bypasses. |
| `.codex/hooks.json` | The Codex mirror of the same hook chain. Codex has no `permissions` slot, so the same bans are enforced through `kata verify` on PreToolUse. |
| `AGENTS.md` | The canonical, agent-agnostic instruction file. Codex loads it natively. |
| `CLAUDE.md` | A thin Claude Code entrypoint that imports `AGENTS.md` via `@AGENTS.md` and adds Claude-specific harness notes. |

These four files are the harness. They make an agent run `kata verify --json` on
every file write and `pnpm test` before it can end a session. See
[the harness](/guide/harness) for what each hook does and why parity between
Claude and Codex is enforced by construction.

### Options

```
-C, --cwd <dir>     Project root to scaffold into (default: current directory)
-f, --force         Overwrite existing files instead of skipping them
    --with-example  Also scaffold a runnable example app (GET /health)
-h, --help          Show this help
```

`--cwd` also accepts the `--cwd=<dir>` form.

### Idempotency

`kata init` is safe to re-run. An existing file is left untouched and reported as
`skip`; only missing files are written. Pass `--force` to overwrite the four
harness files instead.

```
kata init → /path/to/project
    skip  .claude/settings.json
    skip  .codex/hooks.json
    skip  AGENTS.md
    skip  CLAUDE.md

Some files already existed and were left untouched.
Re-run with --force to overwrite them.
```

::: tip
Re-run `kata init` after upgrading Kata to pull in updated hook configs with
`--force`. Because the harness files are the only thing it overwrites, your
source stays untouched.
:::

## `kata init --with-example`

```bash
kata init --with-example
```

Writes the four harness files **and** a minimal runnable app on top of them:

```
kata init → /path/to/project
  create  .claude/settings.json
  create  .codex/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
  create  src/context.ts
  create  src/main.ts
  create  src/modules/health/health.route.ts
  create  src/modules/health/health.schema.ts
  create  package.json
  create  tsconfig.json
```

The example is the smallest app that boots and passes `kata verify`: a single
`GET /health` route that declares `input` and `output`, keeps its schema in a
separate `.schema.ts`, and uses no DI.

| File | What it is |
|---|---|
| `src/context.ts` | `defineContext({})` plus a re-export of `createApp` / `defineRoute`. The typed DI surface, starting empty. |
| `src/main.ts` | `createApp({ modules: [health] })` wired to `serve` from `@hono/node-server`. |
| `src/modules/health/health.route.ts` | `defineRoute` for `GET /health` → `200 {"status":"ok"}`. |
| `src/modules/health/health.schema.ts` | `HealthSchema` — the Zod response DTO. |
| `package.json` | Scripts and pinned deps. Written **only if absent**. |
| `tsconfig.json` | Strict, self-contained compiler options. Written **only if absent**. |

### Zero to `GET /health`

```bash
mkdir my-app && cd my-app
kata init --with-example
pnpm install
pnpm start          # tsx src/main.ts → http://localhost:3000
```

```bash
curl localhost:3000/health
# {"status":"ok"}
```

Installing dependencies is the one manual step — a scaffolder cannot ship
`node_modules`. After that, `pnpm start` runs `src/main.ts` and `pnpm dev` runs
it in watch mode.

::: warning Pre-release
Kata is not yet published to npm, so `pnpm install` cannot resolve the generated
`package.json` yet. Until then, run the worked example from the repo — see
[Quickstart](/guide/quickstart).
:::

### What the generated files contain

`src/context.ts` — the typed DI surface. It starts empty; you register
`singleton(...)` / `scoped<T>()` slots here as the app grows.

```ts
import { defineContext } from 'kata'

export const k = defineContext({})

export const { defineRoute, createApp } = k
```

`src/modules/health/health.schema.ts` — the response DTO. Schemas live in their
own `.schema.ts`, never inline in the route.

```ts
import { z } from 'zod'

export const HealthSchema = z.object({
  status: z.literal('ok'),
})

export type Health = z.infer<typeof HealthSchema>
```

`src/modules/health/health.route.ts` — the smallest valid route. It declares
both `input` and `output`.

```ts
import { defineRoute } from '../../context'

import { HealthSchema } from './health.schema'

export const healthRoute = defineRoute({
  method: 'GET',
  path: '/health',
  input: {},
  output: HealthSchema,
  handler: () => ({ status: 'ok' as const }),
})
```

`src/main.ts` — entry point. `createApp` takes the route modules as namespace
imports; `serve` boots them on Node.

```ts
import { serve } from '@hono/node-server'

import { createApp } from './context'
import * as health from './modules/health/health.route'

const app = createApp({ modules: [health] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log('kata: listening on http://localhost:' + info.port)
})
```

Grow the app by adding modules under `src/modules/<domain>/` and listing them in
`createApp({ modules: [...] })`. See [Routes & schemas](/guide/routes-schemas)
for the full route surface and [Project layout](/guide/project-layout) for the
locked folder structure.

### `package.json` / `tsconfig.json` are never clobbered

The four source files honour `--force` like the harness files. The two manifests
do not: an existing `package.json` or `tsconfig.json` is **always** left
untouched, even with `--force`. Running `--with-example` inside a project that
already has a manifest fills in only the missing source files and reports the
manifests as `skip` — it never rewrites your dependency list or compiler config.

::: warning
`kata init --with-example` scatters `src/` files into the current directory.
Run it in a fresh or Kata-shaped directory; skip-on-exists protects existing
files, but the new ones still appear where you run it.
:::

## Other commands

There are none. `kata` has a single command, `init`. Running `kata` with no
command, or with an unknown command, prints the usage help and exits non-zero:

```bash
kata
# kata: missing command (try `kata init`)
```

A per-domain module generator (`kata new <domain>`) is reserved but not yet
implemented; see [ADR-0015](/adr/0015-bootstrap-cli) for the decision to extend
`kata init` with a flag rather than add a second scaffolding command.

## See also

- [The harness](/guide/harness) — what the generated hook configs enforce.
- [Quickstart](/guide/quickstart) — build and boot a full `/users` API by hand.
- [ADR-0015](/adr/0015-bootstrap-cli) — why the bootstrap is a flag on `init`.
