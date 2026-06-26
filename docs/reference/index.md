---
title: API reference
description: Every public export across kata, kata/jwt, and kata/node, plus the kata bin and peer dependencies.
---

# API reference

Kata ships one package, `kata`, with three import paths and one binary. Nothing
is re-exported from Hono — the public surface is exactly what the tables below
list, derived from the package's own entry points.

| Import | Purpose |
|---|---|
| `kata` | Core: the context factory, slot constructors, the error envelope, built-in middleware, and every public type. |
| `kata/jwt` | Stateless JWT primitives plus the `jwtAuth` middleware and authorization guards. |
| `kata/node` | Node-only `gracefulShutdown` for draining a server on `SIGTERM` / `SIGINT`. |
| `kata` (bin) | The CLI: `kata init` scaffolds a full app, `kata new` adds a module, `kata verify` runs the lint rules. |

```ts
import { defineContext, scoped, singleton } from 'kata'
import { jwtAuth, requireRole, signJwt } from 'kata/jwt'
import { gracefulShutdown } from 'kata/node'
```

The split is deliberate: `kata` is runtime-neutral and runs wherever Hono runs
(Node, Bun, Deno, edge), `kata/jwt` is the only module that touches `hono/jwt`,
and `kata/node` is the only module that touches `node:process` — so an edge build
that imports `kata` never pulls in Node internals.

## Peer dependencies

Kata declares two peer dependencies. Install them alongside `kata`; it bundles
neither.

```json
{
  "peerDependencies": {
    "hono": "^4",
    "zod": "^3"
  }
}
```

| Peer | Range | Used for |
|---|---|---|
| `hono` | `^4` | The router, context, runtime adapters, and the typed RPC client (`hc`). |
| `zod` | `^3` | Every `input` / `output` schema and the claims schemas in `kata/jwt`. |

## `kata` — core

Values:

| Export | Kind | Purpose |
|---|---|---|
| `defineContext` | function | The single DI registry. Takes a registry of slots and returns `{ registry, defineRoute, defineMiddleware, createApp }`, all bound to it. |
| `singleton` | function | `singleton(value)` — declare a process-lifetime slot holding `value`. |
| `scoped` | function | `scoped<T>()` — declare a per-request slot of type `T`, filled by a middleware. |
| `cors` | function | Built-in CORS middleware. |
| `secureHeaders` | function | Built-in security-headers middleware. |
| `bodyLimit` | function | Built-in request-body size limit middleware. |
| `DEFAULT_MAX_BODY_SIZE` | const | The default byte cap `bodyLimit` enforces when no `maxBytes` is given. |
| `buildErrorBody` | function | Build the unified error envelope (ADR-0008) as a plain object — `{ error, message, issues? }`. |
| `formatZodIssues` | function | Convert a `ZodError` into the `FieldIssue[]` shape used in error envelopes. |
| `ErrorBodySchema` | Zod schema | Zod schema for the error envelope; declare it behind a 4xx/5xx status in an `output` map. |
| `FieldIssueSchema` | Zod schema | Zod schema for one structured field issue; composes `ErrorBodySchema`. |
| `REQUEST_ID_HEADER` | const | The header (`x-request-id`) Kata reads an inbound correlation id from and echoes back. |

Types:

| Export | Purpose |
|---|---|
| `AppConfig` | The object `createApp` accepts (`modules`, `middlewares?`, `requestLogging?`, `outputValidation?`). |
| `Route` | A route value produced by `defineRoute`. |
| `Module` | A record of named routes — what an `import * as` of a `*.route.ts` file yields. |
| `Middleware` | A middleware value produced by `defineMiddleware`. |
| `MiddlewareContext` | The `c` passed to a middleware handler (`get`, `set`, `header`, `json`, `error`, `raw`, `requestId`). |
| `RouteContext` | The `c` passed to a route handler (`get`, `input`, `json`, `error`, `raw`, `requestId`). |
| `HttpMethod` | The supported methods: `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'`. |
| `InputSchemas` | The `input` shape: `{ params?, query?, body?, headers? }` of Zod schemas. |
| `InferInput` | `z.infer` of an `InputSchemas`, as exposed on `c.input`. |
| `OutputSpec` | A route's `output`: a single Zod schema or an `OutputMap`. |
| `OutputMap` | A status-code → Zod schema map, e.g. `{ 200: X, 404: Y }`. |
| `SuccessOutput` | The 200 body type a handler may return as a plain value. |
| `RouteHandlerReturn` | What a handler may return: `SuccessOutput` or a `Response`. |
| `Registry` | The registry type `defineContext` accepts — a record of `Slot`s. |
| `Slot` | A `Singleton<unknown>` or `Scoped<unknown>`. |
| `Singleton` | A singleton slot type. |
| `Scoped` | A scoped slot type. |
| `SingletonKeys` | The singleton keys of a registry. |
| `ScopedKeys` | The scoped keys of a registry — the only keys a middleware may `provides`/`set`. |
| `ResolvedValue` | The value type a slot resolves to via `c.get`. |
| `Logger` | The structured logger shape a `logger` singleton may satisfy for per-request logging. |
| `OutputValidationMode` | `'strict' \| 'log' \| 'off'` — how an output-schema mismatch is handled (ADR-0009). |
| `ErrorBody` | The error-envelope object type: `{ error, message, issues? }`. |
| `ErrorExtra` | The optional extras for `c.error` / `buildErrorBody`: `{ status?, issues? }`. |
| `FieldIssue` | One structured field error: `{ path, message, code, expected?, received? }`. |
| `FieldIssues` | `Record<string, FieldIssue[]>`, keyed by input source. |
| `KataApp` | The parametric Hono app type `createApp` returns — `export type AppType = KataApp<typeof modules>` powers the RPC client. |
| `RpcModule` | The wire-relevant projection of a module used by the RPC type bridge. |
| `ModulesToHonoSchema` | The Hono RPC `Schema` derived from a modules tuple. |

Built-in middleware option types — `CorsOptions`, `SecureHeadersOptions`, and
`BodyLimitOptions` — are also exported. See [Middleware](/reference/middleware)
for their fields.

## `kata/jwt` — auth

Values:

| Export | Kind | Purpose |
|---|---|---|
| `signJwt` | function | `signJwt(claims, options)` — sign a claims object into a compact JWT. Stamps `iat`; `options` set the registered claims (`exp`, `nbf`, `iss`, `aud`, `sub`). |
| `verifyJwt` | function | `verifyJwt(token, options)` — verify signature + time claims, then parse the payload through `options.claims`. Returns a `Result`, never throws. |
| `jwtAuth` | function | Build a middleware *handler* that reads `Authorization: Bearer <token>`, verifies it, and writes the claims (or a `resolve`d user) into a scoped slot. Wrap with `defineMiddleware({ provides: [...] })`. |
| `guard` | function | Build an authorization guard *handler* that reads an already-provided slot and rejects with a 403 envelope when `authorize` returns false. |
| `requireRole` | function | Sugar over `guard`: allow only when the slot value's `role` is (one of) the given role(s). |
| `requireClaim` | function | Sugar over `guard`: allow only when the slot value's claim at `key` equals `expected` (or passes the given predicate). |

Types:

| Export | Purpose |
|---|---|
| `JwtAlgorithm` | The supported signing algorithms (`HS*`, `RS*`, `PS*`, `ES*`, `EdDSA`). |
| `SignOptions` | Options for `signJwt`: `secret`, `alg?`, `expiresInSeconds?`, `notBeforeSeconds?`, `issuer?`, `audience?`, `subject?`. |
| `VerifyOptions` | Options for `verifyJwt`: `secret`, `claims`, `alg?`, `issuer?`, `audience?`. |
| `JwtVerifyResult` | The `verifyJwt` result: `{ ok: true, claims }` or `{ ok: false, error }`. |
| `JwtError` | A verify failure: `{ code, message, issues? }`. |
| `JwtErrorCode` | `'invalid_token' \| 'expired' \| 'claims_mismatch'`. |
| `JwtAuthOptions` | Options for `jwtAuth`: `secret`, `claims`, `slot?`, `alg?`, `issuer?`, `audience?`, `header?`, `resolve?`. |
| `GuardOptions` | Options for `guard`: `slot?`, `authorize`, `code?`, `message?`. |

::: tip You own the login flow
`kata/jwt` gives you signing, verification, the auth middleware, and guards.
Password hashing, the user store, the login route, and refresh tokens stay yours.
See the [Authentication cookbook](/cookbook/auth) for the full pattern.
:::

## `kata/node` — Node runtime

Values:

| Export | Kind | Purpose |
|---|---|---|
| `gracefulShutdown` | function | `gracefulShutdown(server, options)` — trap termination signals, stop accepting connections, drain in-flight requests, then run `onClose`. |

Types:

| Export | Purpose |
|---|---|
| `ServerType` | The `node:http` / `node:http2` server handle `@hono/node-server`'s `serve()` returns. |
| `GracefulShutdownOptions` | Options for `gracefulShutdown`: `onClose`, `signals?` (default `['SIGTERM', 'SIGINT']`), `timeoutMs?` (default `10_000`). |

`gracefulShutdown` takes the *server*, not the app: the app is the request
handler, the server owns the socket that must be `close()`d to drain. Opt in from
`main.ts` — `createApp` installs no signal handlers.

## `kata` — the bin

The package installs a `kata` binary with three commands: `kata init` scaffolds a
project, `kata new <domain>` adds a module, and `kata verify` runs the lint rules.

```bash
kata init [dir] [options]
```

| Option | Purpose |
|---|---|
| `-C, --cwd <dir>` | Base directory to resolve `[dir]` against. Defaults to the current directory. |
| `--minimal` | Write only the harness configs — no app (for existing projects). |
| `-f, --force` | Overwrite existing source files (never the manifests/configs). |
| `-h, --help` | Print usage and exit. |

By default `kata init` writes a complete, runnable app: the harness
(`.claude` / `.codex` / `.agents` + `AGENTS.md` / `CLAUDE.md` / `lefthook.yml`),
the canonical `src/` layout with two example modules, and — only if absent —
`package.json`, `tsconfig.json`, and the lint configs. See [The CLI](/guide/cli)
for the full walkthrough.

## Reference pages

- [defineContext](/reference/define-context) — the DI registry and slot kinds.
- [defineRoute](/reference/define-route) — route config, `input`, and `output`.
- [defineMiddleware](/reference/define-middleware) — `provides` and the handler.
- [createApp](/reference/create-app) — `AppConfig` and the returned Hono app.
- [Middleware](/reference/middleware) — `cors`, `secureHeaders`, `bodyLimit`.
- [JWT](/reference/jwt) — `signJwt`, `verifyJwt`, `jwtAuth`, and the guards.
