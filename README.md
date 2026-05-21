# Kata

> A web framework on Hono. Opinionated like NestJS, functional like a script,
> verifiable like a type system. Built so AI agents and humans both produce
> correct code on the first try.

## Status

Early design. No code yet. Decisions live in [`docs/adr/`](docs/adr/).

## Thesis (TL;DR)

Three invariants make Kata mechanically verifiable in a Claude Code / Codex
`PostToolUse` hook in under 100ms:

1. **Static DI** — every dependency is declared in one `defineContext({...})`.
   No string-keyed lookups that escape the type system.
2. **Mandatory schemas** — every route declares input and output schemas.
   Lint fails if either is missing.
3. **Locked folder layout** — `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts`.
   No free-floating handlers.

These constraints power `kata verify`, which returns `hookSpecificOutput.additionalContext`
JSON for agent self-correction. See [ADR-0001](docs/adr/0001-use-hono-as-base.md)…
[ADR-0005](docs/adr/0005-dtos-in-separate-schema-file.md) for the full reasoning.

## Why another framework

| | Nest | Elysia | Hono + Zod template | Kata |
|---|---|---|---|---|
| Functional only | ❌ | ✅ | ✅ | ✅ |
| Runs on Hono (Node, Bun, Deno, Edge) | ❌ | ❌ (Bun) | ✅ | ✅ |
| Mandatory schemas (lint-enforced) | ❌ | ⚠️ | ❌ | ✅ |
| Statically enumerable DI | ❌ | ⚠️ | ❌ | ✅ |
| Harness hooks shipped natively | ❌ | ❌ | ❌ | ✅ |

## License

TBD (will be open-source).
