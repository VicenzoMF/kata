// Issue #31 — the `AGENTS.md` a freshly `kata init`-ed project gets: the
// canonical, agent-agnostic instruction file (AAIF standard). Codex loads it
// natively; Claude Code imports it from the generated `CLAUDE.md`. Kept
// pointer-style and under 50 lines per the harness-engineering article.
//
// Stored as a newline-joined line array rather than a template literal: the
// document is dense with Markdown inline-code, and a template literal would
// need every one of those backticks escaped.

import { type PackageManager, pmCommands } from '../package-manager'
import { KATA_ADR_TAG } from './version'

/** `pm` is the package manager detected for the target project (issue #302) —
 *  the printed `test`/`typecheck` commands resolve through it instead of
 *  assuming pnpm, matching the harness hooks (issue #231). */
function lines(pm: PackageManager): readonly string[] {
  const { run } = pmCommands(pm)
  return [
    '# Agent Instructions',
    '',
    'Canonical instructions for every agent on this project. Codex loads this',
    'file natively; Claude Code imports it from `CLAUDE.md`.',
    '',
    '## Verify your work',
    '- `kata verify` — fast deterministic checks; use `--json` for hook output, and',
    '  `--strict-coverage` (what pre-commit runs) to fail on checks a rule could',
    '  not prove — an unresolvable middleware in a chain, for instance.',
    `- \`${run('test')}\` — unit tests + Hurl E2E.`,
    `- \`${run('typecheck')}\` — \`tsc --noEmit\`.`,
    '',
    '## Architectural decisions',
    "This app's own decisions live as ADRs under `docs/adr/`; read the relevant",
    "one before deviating. Kata's framework ADRs (why the framework itself works",
    `this way) are at https://github.com/VicenzoMF/kata/tree/${KATA_ADR_TAG}/docs/adr.`,
    '',
    '## Mandatory folder layout',
    '```',
    'src/',
    '├── app.ts                # createApp({ modules })',
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
}

/** The exact `AGENTS.md` bytes (newline-joined, trailing newline) `kata init`
 *  writes for the given package manager (issue #302). */
export function agentsMd(pm: PackageManager): string {
  return `${lines(pm).join('\n')}\n`
}
