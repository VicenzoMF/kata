---
title: Why Kata
description: Why a framework that takes freedom away — and where it stops.
---

# Why Kata

Most web frameworks compete on freedom. They give you more ways to wire a
route, register a dependency, or place a file. Kata does the opposite. It
removes choices, on purpose, because the choices are where the wrong code comes
from.

## The problem: freedom produces wrong code

Hono is small and unopinionated. That is a strength for the runtime and a
liability for a team. With nothing to enforce structure, every contributor —
human or agent — invents their own. Schemas drift inline into route files. A
dependency gets read from a module-level singleton in one place and a closure in
another. Handlers live wherever the last person dropped them. Some routes
validate their output; most do not.

This is not a discipline problem you can fix with a style guide. The freedom is
the cause. When the framework permits ten shapes, an LLM will produce a
plausible-looking mix of all ten, and a reviewer has to catch the difference by
reading. The cost compounds: every loose convention is a place the next change
can go wrong, and there is no mechanism that says it did.

Kata's bet is that for building HTTP services, the marginal freedom is worth
less than the cost of policing it. So it picks one shape for each decision and
makes the rest a type error.

## How Kata differs

| | Nest | Elysia | Hono + Zod template | Kata |
|---|---|---|---|---|
| Functional only | ❌ | ✅ | ✅ | ✅ |
| Runs on Hono (Node, Bun, Deno, Edge) | ❌ | ❌ (Bun) | ✅ | ✅ |
| Mandatory schemas (lint-enforced) | ❌ | ⚠️ | ❌ | ✅ |
| Statically enumerable DI | ❌ | ⚠️ | ❌ | ✅ |
| Harness hooks shipped natively | ❌ | ❌ | ❌ | ✅ |

Read the table by its columns:

- **Nest** is opinionated, but the opinions are classes, decorators, and a
  runtime IoC container. Dependencies are resolved by reflection at runtime, so
  the wiring is not *statically enumerable* — you cannot list every dependency by
  reading one file — and schemas are a convention you opt into per route. Kata
  keeps the opinionatedness and drops the machinery.
- **Elysia** is functional and validation-first, but it is Bun-only and its
  schema and DI discipline is by convention, not lint-enforced (`⚠️`). Nothing
  fails the build when a route ships without a contract.
- **A Hono + Zod template** runs everywhere and is functional, but a template is
  a starting point, not a constraint. The day-two structure is whatever each
  contributor decides, and there is no harness in the box.
- **Kata** is the only column that is `✅` down the line: functional only, runs
  anywhere Hono runs, schemas and DI that the lint harness actually enforces,
  and the harness hooks shipped with the framework rather than reinvented per
  project.

The last row is the one no other framework has. It is also the point.

## Less freedom, on purpose

Kata reduces the design space to three invariants, and it does so because those
three are mechanically checkable in a Claude Code or Codex `PostToolUse` hook in
under 100ms:

1. **Static DI.** Every dependency is declared in one `defineContext({...})`.
   No string-keyed lookups that escape the type system — `c.get('key')` only
   compiles for a key you registered.
2. **Mandatory schemas.** Every route declares `input` and `output` schemas.
   Omitting either is a TypeScript error, and the lint fails on it.
3. **Locked folder layout.** Code lives at
   `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts`. No
   free-floating handlers; every route, service, schema, and test is findable by
   glob.

Each constraint is chosen to be *enumerable*. A verifier does not need to
understand your business logic to check them — it greps the layout, reads the
`defineContext`, and confirms each `defineRoute` has both schemas. That is why
`kata verify` can run on every file write and return
`hookSpecificOutput.additionalContext` JSON the agent uses to self-correct,
before a single test runs.

::: tip This is harness engineering
Kata is built on a simple premise: **enforce quality with mechanisms, not
prompts.** A rule that lives in a prompt or a contributing guide erodes within a
handful of sessions — for an agent and for a human. A rule that is a type error,
a failed lint, or a blocked commit does not. Kata's invariants exist precisely
so they can be machine-enforced.
:::

The reasoning is the same one Kata applied to itself. [ADR-0007](/adr/0007-self-apply-harness-before-feature-work)
made building the harness a milestone that *blocked* all feature work, on the
principle that "scaling without a harness creates compounding cognitive debt,
not compounding leverage." The framework is its own first user: the loop that
keeps your code correct is the loop Kata's own development runs on.

For the mechanics — what `kata verify` checks, how the hooks wire into Claude
Code and Codex, and how feedback reaches the agent — see [the harness guide](/guide/harness).

## Where Kata stops, on purpose

A framework that takes freedom away has to be just as disciplined about where it
*doesn't* reach, or the opinions become a cage. Kata draws a hard line:

> Kata owns the request. Infrastructure and product policy stay yours.

Concretely, Kata owns typed routing, mandatory `input` / `output` validation,
dependency injection, the error envelope, and the request lifecycle. It does
**not** ship a persistence layer, a rate limiter, a metrics exporter, a config
loader, or a pagination helper. Those are bring-your-own — not gaps, but the
boundary.

This is deliberate. Each of those concerns depends on your infrastructure or
your product, and baking in a choice would lock you to a vendor or a shape while
bloating the core that the verifier has to keep small and checkable. Kata gives
you the levers instead: a **singleton** slot for a long-lived client, a
**scoped** slot for per-request state, and a plain Hono app you can extend with
any middleware. Your database, limiter, and metrics drop onto those levers
without waiting on the framework.

::: info Bring-your-own is a feature
If you reach for a built-in and find none, that is the design, not an omission.
The [non-goals cookbook](/cookbook/non-goals) shows the idiomatic BYO for
persistence, rate-limiting, metrics, env validation, and pagination — each on a
lever you already have.
:::

## The shape of it

Kata is what NestJS would be if it were a script instead of a runtime: the same
"there is one right way," expressed as functions, named exports, and Zod
schemas rather than classes and decorators — and verified by a type system
instead of trusted by convention. The name is the thesis. A *kata* is a
practiced form: disciplined, repeatable, correct the first time.

Convinced of the constraints? Go build something.

- [Quickstart](/guide/quickstart) — a fully-typed `/users` API in six files.
- [Context & DI](/guide/context-di) — the one registry every dependency lives in.
- [Routes & schemas](/guide/routes-schemas) — `defineRoute` and mandatory contracts.
- [The harness](/guide/harness) — how the verifier and hooks keep code correct.
