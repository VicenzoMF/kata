// Issue #31 — the `AGENTS.md` a freshly `kata init`-ed project gets: the
// canonical, agent-agnostic instruction file (AAIF standard). Codex loads it
// natively; Claude Code imports it from the generated `CLAUDE.md`. Kept
// pointer-style and under 50 lines per the harness-engineering article.
//
// Stored as a newline-joined line array rather than a template literal: the
// document is dense with Markdown inline-code, and a template literal would
// need every one of those backticks escaped.

const LINES: readonly string[] = [
  '# Agent Instructions',
  '',
  'Canonical instructions for every agent on this project. Codex loads this',
  'file natively; Claude Code imports it from `CLAUDE.md`.',
  '',
  '## Verify your work',
  '- `kata verify` — fast deterministic checks; use `--json` for hook output.',
  '- `pnpm test` — unit tests + Hurl E2E.',
  '- `pnpm typecheck` — `tsc --noEmit`.',
  '',
  '## Architectural decisions',
  'Architectural decisions live as ADRs under `docs/adr/`. Read the relevant',
  'ADR before deviating. Statuses: `Accepted | Superseded by ADR-NNNN | Deprecated`.',
  '',
  '## Mandatory folder layout',
  '```',
  'src/',
  '├── app.ts                # createApp({ context, modules })',
  '├── context.ts            # defineContext({ ... })',
  '├── middlewares/',
  '└── modules/<domain>/',
  '    ├── <domain>.route.ts     # defineRoute calls only',
  '    ├── <domain>.service.ts   # pure functions',
  '    ├── <domain>.schema.ts    # Zod schemas (DTOs)',
  '    ├── <domain>.hurl         # API E2E',
  '    └── <domain>.test.ts      # unit tests',
  '```',
  '',
  '## Conventions',
  '- Functional only — no classes, no decorators.',
  '- Named exports only — no default exports.',
  '- `any` is forbidden — use `unknown` + narrowing.',
  '- Schemas live in `<domain>.schema.ts`, never inline in `.route.ts`.',
  '- Every route declares `input` and `output` schemas.',
  "- DI: `c.get('key')` only compiles if `'key'` is in `defineContext`.",
  '',
  '## Prohibitions',
  '- Do not edit lint or framework configs to silence errors. Fix the code.',
  '- Do not bypass git hooks — `--no-verify` is banned.',
  '- Do not introduce request-scoped state outside the `scoped<T>()` slot mechanism.',
]

/** The exact `AGENTS.md` bytes (newline-joined, trailing newline) `kata init`
 *  writes. Exported pre-rendered so `generators.ts` stays a thin re-export
 *  layer, symmetric with the JSON templates. */
export const agentsMd = `${LINES.join('\n')}\n`
