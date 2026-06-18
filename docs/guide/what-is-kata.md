---
title: What is Kata
description: A thin, opinionated layer on Hono — functional, schema-complete, and mechanically verifiable.
---

# What is Kata

Kata is a thin, opinionated layer on top of [Hono](https://hono.dev). Hono gives
you the router, the cross-runtime adapters, and the typed RPC client. Kata adds
the part Hono leaves open: **how you structure an app, where dependencies come
from, and what a route is allowed to look like.**

> Opinionated like NestJS, functional like a script, verifiable like a type
> system. Built so AI agents and humans both produce correct code on the first
> try.

The name is the thesis. A _kata_ is a disciplined, practiced form — and `型`
also means *type* and *mold*. Kata is a mold for backend code: one shape, drilled
until it is automatic, the same whether a human or an agent writes it.

## A thin layer, not a rewrite

**Kata wraps Hono; it does not replace it.** It builds on Hono's router and
context but never re-exports Hono's API. The entire public surface is four
functions — `defineContext`, `defineRoute`, `defineMiddleware`, `createApp` —
plus Hono's RPC client: the piece that lets a TypeScript caller hit your API and
get back the server's *exact* request and response types, with no codegen and no
separately built client ([ADR-0001](/adr/0001-use-hono-as-base)). Everything else
is a plain object you pass to one of those four functions.

```ts
import { defineContext, scoped, singleton } from 'kata'

export const k = defineContext({
  logger: singleton(console),
  currentUser: scoped<{ id: string }>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

`defineContext` is the root of everything. You hand it your dependency registry,
and it hands back `defineRoute`, `defineMiddleware`, and `createApp` — already
bound to that registry, so the rest of your app inherits the types for free.

Because Kata sits *on* Hono rather than hiding it, two things follow:

- It runs wherever Hono runs — Node, Bun, Deno, edge.
- The app `createApp` returns is a real Hono app you can extend.

## Functional only

Kata has no classes, no decorators, and no runtime IoC container
([ADR-0002](/adr/0002-no-classes-no-decorators)). The whole vocabulary is
smaller than that:

- A route is `defineRoute({...})` — and nothing else.
- A dependency is one entry in `defineContext`.

There is no `@Injectable()`, no metadata reflection, no inheritance chain to
trace.

This is not nostalgia — it is what makes the code checkable by a tool.
NestJS-style decorators hide control flow that is hard to grep and hard to
verify: the metadata runs at decoration time, the container resolves at runtime,
and neither is visible in the source you are reading. Kata bets the opposite way
— **constraints aid agents.** Functions, plain objects, and explicit imports can
be inspected by a machine, not just a human.

Two rules fall out of that bet, and Kata enforces both: named exports only, and
no `any` (use `unknown` and narrow).

## Three invariants

Kata enforces three rules. Together they make an app *mechanically verifiable* —
meaning a program, not just a human reviewer, can confirm the rules hold.
Concretely, that check is a lint pass in a `PostToolUse` hook: under 100ms, no app
boot.

### 1. Static DI

Every dependency is declared in a single `defineContext({...})`. A dependency is
one of two slot kinds:

- `singleton(value)` — one value for the whole process (a db pool, a logger, a
  mailer).
- `scoped<T>()` — one value per request, filled in by a middleware (the current
  user, a tenant id, a transaction).

`c.get('key')` only type-checks for a key you actually registered. Nothing
escapes the type system through string-keyed lookups, so the entire dependency
graph can be read off from one file ([ADR-0004](/adr/0004-di-via-scoped-slots)).

### 2. Mandatory schemas

Every route declares both an `input` and an `output` schema. Omit either and it
is a TypeScript error, not a runtime surprise
([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

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

Those two schemas guard both ends of the handler:

- **`input` is checked before the handler runs.** On failure Kata returns `422`
  with a normalised `{ error: "validation_failed", issues }` envelope — your code
  never sees bad input.
- **`output` is checked after the handler returns.** A mismatch is logged and
  turned into `500 { "error": "internal_output_shape_mismatch" }`, so the wrong
  shape never reaches the client.

The same Zod schemas also drive the typed RPC client — no codegen, no shared
runtime.

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
checks. Because the shape is fixed, the check is just a glob plus an AST match —
fast enough to run on every file write and feed the result straight back to an
agent as `hookSpecificOutput.additionalContext` for self-correction. See
[The harness](/guide/harness).
:::

## Who it is for

Humans and agents — served by the same mechanism, not two different ones.

- **Humans** get one obvious way to write a route, and a verifier that catches
  the slip before review.
- **Agents** get a shape they can reliably produce and a check they can read:
  when `kata verify` fails, it returns structured feedback the agent uses to fix
  its own output.

The constraints that make the code greppable for a tool are the very same ones
that make it predictable for a person. That overlap is the whole design.

## What Kata is not

Kata owns the request — and stops there. Inside its borders: typed routing,
mandatory validation, dependency injection, the error envelope, and the
lifecycle. Outside them, on purpose: **no persistence layer, no rate limiter, no
metrics exporter, no config loader, no pagination helpers.**

Those are infrastructure and product policy. They stay yours, so the framework
never locks you into a vendor or a shape. And because `createApp` returns a plain
Hono app, any Hono middleware works app-wide today.

This boundary is deliberate, not a gap. See
[Non-goals & bring-your-own](/cookbook/non-goals) for the idiomatic BYO pattern
for each.

## Next steps

- [Why Kata](/guide/why-kata) — the argument against the alternatives, in full.
- [Quickstart](/guide/quickstart) — a fully-typed `/users` API in six files.
