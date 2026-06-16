---
title: What is Kata
description: A thin, opinionated layer on Hono — functional, schema-complete, and mechanically verifiable.
---

# What is Kata

Kata is a thin, opinionated layer on top of [Hono](https://hono.dev). Hono gives
you the router, the cross-runtime adapters, and the typed RPC client. Kata adds
the part Hono leaves open: how you structure an app, where dependencies come
from, and what a route is allowed to look like.

> Opinionated like NestJS, functional like a script, verifiable like a type
> system. Built so AI agents and humans both produce correct code on the first
> try.

The name is the thesis. A _kata_ is a disciplined, practiced form — and `型`
also means *type* and *mold*. Kata is a mold for backend code: one shape, drilled
until it is automatic, the same whether a human or an agent writes it.

## A thin layer, not a rewrite

Kata wraps Hono's router and context, but it does not re-export Hono's API. The
public surface is four functions — `defineContext`, `defineRoute`,
`defineMiddleware`, `createApp` — plus Hono's RPC client for end-to-end types
([ADR-0001](/adr/0001-use-hono-as-base)). Everything else is a plain object you
pass to one of them.

```ts
import { defineContext, scoped, singleton } from 'kata'

export const k = defineContext({
  logger: singleton(console),
  currentUser: scoped<{ id: string }>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

`defineContext` is the root. It takes your dependency registry and returns
`defineRoute`, `defineMiddleware`, and `createApp` already bound to it, so the
rest of your app inherits the types. Because Kata sits on Hono, it runs wherever
Hono runs — Node, Bun, Deno, edge — and the app `createApp` returns is a real
Hono app you can extend.

## Functional only

Kata has no classes, no decorators, and no runtime IoC container
([ADR-0002](/adr/0002-no-classes-no-decorators)). A route is `defineRoute({...})`
and nothing else. A dependency is an entry in `defineContext`. There is no
`@Injectable()`, no metadata reflection, no inheritance chain to trace.

This is not nostalgia. NestJS-style decorators encode control flow that is hard
to grep and hard to verify mechanically — the metadata runs at decoration time,
the container resolves at runtime, and neither is visible in the source. Kata's
bet is the opposite: **constraints aid agents**. Functions, plain objects, and
explicit imports are inspectable by a tool, not just a human. Named exports only;
the `any` type is forbidden (use `unknown` and narrow).

## Three invariants

Kata enforces three rules. Together they make an app mechanically verifiable —
checkable by a lint pass in a `PostToolUse` hook, in under 100ms, with no app
boot.

### 1. Static DI

Every dependency is declared in a single `defineContext({...})`. There are two
slot kinds:

- `singleton(value)` — one value for the process lifetime (a db pool, a logger,
  a mailer).
- `scoped<T>()` — one value per request, filled by a middleware (the current
  user, a tenant id, a transaction).

`c.get('key')` only type-checks for a key you registered. There are no
string-keyed lookups that escape the type system, so the full dependency graph
is enumerable from one file ([ADR-0004](/adr/0004-di-via-scoped-slots)).

### 2. Mandatory schemas

Every route declares both an `input` and an `output` schema — omitting either is
a TypeScript error ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

```ts
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.json({ error: 'not_found' }, 404)
    return user
  },
})
```

`input` is validated **before** the handler; on failure Kata returns `422` with
a normalised `{ error: "validation_failed", issues }` envelope. `output` is
validated **after** the handler; a mismatch is logged and turned into `500
{ "error": "internal_output_shape_mismatch" }` so the wrong shape never reaches
the client. The same Zod schemas drive the typed RPC client — no codegen, no
shared runtime.

### 3. Locked layout

Every route, service, schema, and test lives at a predictable path, findable by
glob:

```
src/
├── app.ts                # createApp({ context, modules })
├── context.ts            # defineContext({ ... })
├── middlewares/
└── modules/<domain>/
    ├── <domain>.route.ts     # defineRoute calls only
    ├── <domain>.service.ts   # pure functions
    ├── <domain>.schema.ts    # Zod schemas (DTOs)
    ├── <domain>.hurl         # API E2E
    └── <domain>.test.ts      # unit tests
```

No free-floating handlers, no inline schemas. Services are pure functions with
no framework imports. See [Project layout](/guide/project-layout) for the full
rules.

::: tip Why the invariants matter
Static DI, mandatory schemas, and a locked layout are exactly what `kata verify`
checks. Because the shape is fixed, the check is a glob plus an AST match — fast
enough to run on every file write and feed results back to an agent as
`hookSpecificOutput.additionalContext` for self-correction. See
[The harness](/guide/harness).
:::

## Who it is for

Both audiences, by the same mechanism. Humans get one obvious way to write a
route and a verifier that catches the slip before review. Agents get a shape they
can produce and a check they can read: when `kata verify` fails, it returns
structured feedback the agent uses to fix its own output. The constraints that
make the code greppable for a tool are the same ones that make it predictable for
a person.

## What Kata is not

Kata owns the request: typed routing, mandatory validation, dependency injection,
the error envelope, and the lifecycle. It does **not** ship a persistence layer,
a rate limiter, a metrics exporter, a config loader, or pagination helpers. Those
are infrastructure and product policy — they stay yours, so the framework never
locks you into a vendor or a shape. Because `createApp` returns a plain Hono app,
any Hono middleware works app-wide today.

This boundary is deliberate, not a gap. See
[Non-goals & bring-your-own](/cookbook/non-goals) for the idiomatic BYO pattern
for each.

## Next steps

- [Why Kata](/guide/why-kata) — the argument against the alternatives, in full.
- [Quickstart](/guide/quickstart) — a fully-typed `/users` API in six files.
