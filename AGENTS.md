# Kata — Agent Instructions

Loaded by Codex (native) and Claude Code (via `CLAUDE.md` import).

## Verify your work
- `kata verify` — fast determ checks; use `--json` for hook output.
- `pnpm test` — unit tests (vitest).
- `pnpm --filter=<example> hurl` — API E2E (Hurl); needs the example server
  running (`pnpm --filter=<example> start`). CI boots hello + shop and runs both.
- `pnpm typecheck` — `tsc --noEmit`.

## Architectural decisions
All architectural decisions live as ADRs under `docs/adr/`. Read the relevant
ADR before deviating. Statuses: `Accepted | Superseded by ADR-NNNN | Deprecated`.

## Mandatory folder layout
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

## Conventions
- Functional only — no classes, no decorators.
- Named exports only — no default exports.
- `any` is forbidden — use `unknown` + narrowing.
- Schemas live in `<domain>.schema.ts`, never inline in `.route.ts`.
- Every route declares `input` and `output` schemas.
- DI: `c.get('key')` only compiles if `'key'` is in `defineContext`.

## Prohibitions
- Do not edit lint or framework configs to silence errors. Fix the code.
- Do not bypass git hooks (`--no-verify` is banned).
- Do not introduce request-scoped state outside the `scoped<T>()` slot mechanism (ADR-0004).
