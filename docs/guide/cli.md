---
title: Bootstrap CLI
description: kata init scaffolds a complete, runnable Kata app — the canonical layout, two example modules, and the agent harness — in one command. kata new adds modules; kata verify runs the lint rules.
---

# Bootstrap CLI

Kata ships one binary, `kata`, with three commands:

- **`kata init [dir]`** — scaffold a complete, runnable app. This page covers it.
- **`kata new <domain>`** — generate one module skeleton under `src/modules/`.
- **`kata verify [path]`** — run Kata's lint rules; in `--json` mode it emits the
  hook output an agent consumes. Its full surface — the rule set, `--json`, and
  `--watch` — lives in [the harness](/guide/harness); the [`kata verify`](#kata-verify)
  section below is a quick reference.

`kata init` takes you from zero to a running server in one command. It writes the
canonical [project layout](/guide/project-layout) — `src/app.ts`, `src/context.ts`,
a `middlewares/` folder, and two worked modules — on top of the **agent harness**
(the Claude / Codex / agents hook configs and the `AGENTS.md` / `CLAUDE.md`
instruction pair) plus the lint/format toolchain. It does not install anything: it
writes a fixed set of files, idempotently, and reports what it did.

## `kata init`

```bash
kata init my-app      # scaffold into ./my-app
kata init             # …or scaffold into the current directory
```

The optional `[dir]` is created if missing and resolved against `--cwd`
(default: the current directory). The generated `package.json` is named after it.

```
kata init → /path/to/my-app
  create  .claude/settings.json
  create  .codex/hooks.json
  create  .agents/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
  create  lefthook.yml
  create  biome.json
  create  .oxlintrc.json
  create  src/context.ts
  create  src/app.ts
  create  src/main.ts
  create  src/middlewares/request-logger.ts
  create  src/modules/health/health.schema.ts
  create  src/modules/health/health.service.ts
  create  src/modules/health/health.route.ts
  create  src/modules/health/health.test.ts
  create  src/modules/health/health.hurl
  create  src/modules/greetings/greetings.schema.ts
  create  src/modules/greetings/greetings.service.ts
  create  src/modules/greetings/greetings.route.ts
  create  src/modules/greetings/greetings.test.ts
  create  src/modules/greetings/greetings.hurl
  create  package.json
  create  tsconfig.json
  create  .gitignore
  create  README.md

Next steps:
  cd my-app
  pnpm install
  pnpm dev          # → http://localhost:3000/health
  kata verify       # fast deterministic checks
  pnpm test         # unit tests
```

### The harness files

These turn an agent session into a guarded one: it runs `kata verify --json` on
every file write and `pnpm test` before it can end. Parity between the harnesses
is enforced by construction — see [the harness](/guide/harness).

| File | What it is |
|---|---|
| `.claude/settings.json` | Claude Code hooks (PreToolUse / PostToolUse / Stop) plus a `permissions.deny` list that bans config tampering and commit/push verification bypasses. |
| `.codex/hooks.json` | The Codex mirror of the same hook chain. Codex has no `permissions` slot, so the same bans run through `kata verify` on PreToolUse. |
| `.agents/hooks.json` | A **vendor-neutral mirror** of the same Pre/Post/Stop hook chain, for any harness that reads the emerging `.agents/` convention. Same commands as the two above. |
| `AGENTS.md` | The canonical, agent-agnostic instruction file. Codex loads it natively. |
| `CLAUDE.md` | A thin Claude Code entrypoint that imports `AGENTS.md` via `@AGENTS.md` and adds Claude-specific notes. |
| `lefthook.yml` | The local git pre-commit: `kata verify`, Biome format, oxlint, and typecheck on every commit. |

### The app files

The smallest *complete* app that boots, typechecks, tests, and passes
`kata verify` — the canonical [layout](/guide/project-layout), not a tutorial.

| File | What it is |
|---|---|
| `src/context.ts` | `defineContext({})` plus a re-export of `createApp` / `defineRoute` / `defineMiddleware`. The typed DI surface, starting empty. |
| `src/app.ts` | `createApp({ modules, middlewares })` — the application, composed from the modules and the app-level middleware chain. |
| `src/main.ts` | The runtime entry: `serve` the app from `@hono/node-server`. |
| `src/middlewares/request-logger.ts` | An example app-level middleware (`provides: []`) that logs each request. |
| `src/modules/health/` | `GET /health` → `200 {"status":"ok"}` — the smallest route, with the full five-file module set (route / service / schema / test / hurl). |
| `src/modules/greetings/` | `POST /greetings` (validated body) + `GET /greetings/:id` (validated params, `404` on miss) — the create/read pattern. |
| `biome.json` / `.oxlintrc.json` | The formatter and linter configs the pre-commit runs. Written **only if absent**. |
| `package.json` / `tsconfig.json` | Scripts, pinned deps, and strict compiler options. Written **only if absent**. |
| `.gitignore` / `README.md` | Standard ignores and a per-app quickstart. Written **only if absent**. |

### Options

```
-C, --cwd <dir>     Base directory to resolve [dir] against (default: cwd)
    --minimal       Write only the harness configs — no app (for existing projects)
-f, --force         Overwrite existing source files (never the manifests/configs)
-h, --help          Show this help
```

`--cwd` also accepts the `--cwd=<dir>` form.

### Zero to a running server

```bash
kata init my-app
cd my-app
pnpm install        # the one manual step — a scaffolder can't ship node_modules
pnpm dev            # tsx watch src/main.ts → http://localhost:3000
```

```bash
curl localhost:3000/health
# {"status":"ok"}

curl -X POST localhost:3000/greetings -H 'content-type: application/json' -d '{"name":"Ada"}'
# {"id":"…","message":"Hello, Ada!"}
```

The generated `package.json` wires the everyday scripts: `pnpm dev` (watch),
`pnpm start`, `pnpm test` (Vitest), `pnpm typecheck`, `kata verify`, and
`pnpm hurl` (the `.hurl` API E2E suite — needs [Hurl](https://hurl.dev) installed
and the server running).

::: warning Pre-release & package name
The framework publishes to npm as **`katajs`** (the `kata` name was already taken),
so the generated `package.json` depends on `katajs`. The CLI/bin stays `kata` — the
scripts and hooks call `kata verify`. It is not published yet, so `pnpm install`
cannot resolve the generated `package.json` until it lands; meanwhile, run the
worked example from the repo (see [Quickstart](/guide/quickstart)).
:::

### `kata init --minimal`

To add the harness to an **existing** project without scattering an app into it,
pass `--minimal`: it writes only the six harness files (`.claude` / `.codex` /
`.agents` / `AGENTS.md` / `CLAUDE.md` / `lefthook.yml`) and nothing else.

```bash
kata init --minimal
```

```
kata init → /path/to/project
  create  .claude/settings.json
  create  .codex/hooks.json
  create  .agents/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
  create  lefthook.yml

Harness configs written. Commit them, then start coding —
the PreToolUse/Stop hooks run `kata verify` and `pnpm test` for you.
```

### Idempotency

`kata init` is safe to re-run. An existing file is left untouched and reported as
`skip`; only missing files are written. Pass `--force` to overwrite the **source**
files — the manifests and configs are never touched (see below).

```
kata init → /path/to/my-app
    skip  .claude/settings.json
    skip  src/app.ts
    …
Some files already existed and were left untouched.
Re-run with --force to overwrite source files (manifests are never touched).
```

::: tip
Re-run `kata init --force` after upgrading Kata to pull in updated harness and
source files. Your `package.json`, `tsconfig.json`, and lint configs stay put.
:::

### Manifests and configs are never clobbered

The `src/` files honour `--force`. The manifests and lint/format configs do not:
an existing `package.json`, `tsconfig.json`, `biome.json`, `.oxlintrc.json`,
`.gitignore`, or `README.md` is **always** left untouched, even with `--force`.
Running `kata init` inside a project that already has these fills in only the
missing files and reports the rest as `skip` — it never rewrites your dependency
list, compiler config, or lint rules.

### What the example modules contain

`src/modules/greetings/greetings.schema.ts` — all the domain's Zod schemas live
here, never inline in the route ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).

```ts
import { z } from 'zod'

export const CreateGreetingBodySchema = z.object({ name: z.string().min(1) })
export const GreetingParamsSchema = z.object({ id: z.string() })
export const GreetingSchema = z.object({ id: z.string(), message: z.string() })

export type CreateGreetingBody = z.infer<typeof CreateGreetingBodySchema>
export type Greeting = z.infer<typeof GreetingSchema>
```

`src/modules/greetings/greetings.route.ts` — a POST and a GET, each declaring
`input` and `output` and importing its schemas by name.

```ts
import { defineRoute } from '../../context'

import { CreateGreetingBodySchema, GreetingParamsSchema, GreetingSchema } from './greetings.schema'
import { createGreeting, getGreeting } from './greetings.service'

export const createGreetingRoute = defineRoute({
  method: 'POST',
  path: '/greetings',
  input: { body: CreateGreetingBodySchema },
  output: GreetingSchema,
  handler: (c) => createGreeting(c.input.body),
})

export const getGreetingRoute = defineRoute({
  method: 'GET',
  path: '/greetings/:id',
  input: { params: GreetingParamsSchema },
  output: GreetingSchema,
  handler: (c) => {
    const greeting = getGreeting(c.input.params.id)
    if (!greeting) return c.error('not_found', 'Greeting not found', { status: 404 })
    return greeting
  },
})
```

`src/app.ts` — the application: modules as namespace imports, plus the app-level
middleware chain ([ADR-0012](/adr/0012-app-level-middleware)).

```ts
import { createApp } from './context'
import { requestLogger } from './middlewares/request-logger'
import * as greetings from './modules/greetings/greetings.route'
import * as health from './modules/health/health.route'

export const app = createApp({
  modules: [health, greetings],
  middlewares: [requestLogger],
})
```

Grow the app by adding modules under `src/modules/<domain>/` and listing them in
`createApp({ modules: [...] })`. The next section's `kata new` does the boilerplate.

## `kata new`

Add a module to an existing app:

```bash
kata new orders
```

```
kata new orders → /path/to/project
  create  src/modules/orders/orders.route.ts
  create  src/modules/orders/orders.service.ts
  create  src/modules/orders/orders.schema.ts
  create  src/modules/orders/orders.test.ts
  create  src/modules/orders/orders.hurl
```

It writes the five-file module skeleton — route / service / schema / test / hurl —
into `src/modules/<domain>/`. Register it in `src/app.ts` by importing the route
module and adding it to `createApp({ modules: [...] })`. Like `kata init`, it
skips existing files unless you pass `--force`, and honours `--cwd`.

## `kata verify`

Runs Kata's deterministic lint rules over a project:

```bash
kata verify [path]      # default path: the current directory
```

It reads the project, checks the rules anchored to ADR-0003 / 0004 / 0005, and prints
a human-readable report. Two flags shape how it runs:

- `kata verify --json` — emit Claude Code `PostToolUse` hook JSON instead of the
  terminal report. This is exactly what the generated hooks call on every file write.
- `kata verify --watch` — keep running and re-check on change, for a tight local loop.

Run `kata verify --help` for the full flag list. The rule set, the JSON contract, and
how the hooks wire it into Claude Code and Codex are documented in
[the harness](/guide/harness).

## No command, or an unknown one

Running `kata` with no command, or with an unknown command, prints the usage help and
exits non-zero:

```bash
kata
# kata: missing command (try `kata init`)
```

## See also

- [Project layout](/guide/project-layout) — the locked folder structure `kata init` writes.
- [The harness](/guide/harness) — what the generated hook configs enforce.
- [Quickstart](/guide/quickstart) — build and boot a full `/users` API by hand.
- [ADR-0015](/adr/0015-bootstrap-cli) — the original bootstrap decision (the minimal
  app behind `--with-example`), superseded by the full-app-by-default scaffold.
