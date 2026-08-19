# ADR-0023: docs-mcp ships as a publishable npm package with docs bundled at build time

- **Status:** Proposed
- **Date:** 2026-08-19
- **Deciders:** @VicenzoMF

## Context

ADR-0022 decided *how* the docs-search MCP server searches (lexical, not
vector RAG) but not *how it reaches a consumer*. As built, `main.ts` resolved
`docs/` via a path relative to its own location in the monorepo
(`../../../docs`) — correct for running the server from inside this
checkout (dogfooding, `TODO-POC-SPEC.md`), but useless for an app scaffolded
by `kata init` on someone else's machine: there is no Kata monorepo checkout
next to it to read `docs/` from.

`kata init` today is purely flag-driven (`--minimal`, `--force`, `--cwd`,
`--help`) — no interactive prompt library exists anywhere in the repo. Adding
a full interactive "seletor" would be a first-of-its-kind UX shift and risks
breaking any script/CI that already calls `kata init` non-interactively; nothing
in the codebase asked for that yet, so it's out of scope here.

## Decision

We will:

1. **Bundle the docs into `@kata/docs-mcp` at build time.**
   `scripts/copy-docs.mjs` copies `docs/{guide,cookbook,reference,adr}/**/*.md`
   into `packages/docs-mcp/data/docs/` before both `start` (dev) and `build`.
   `main.ts` resolves `docsRoot` as `../data/docs` relative to itself — a
   sibling of `src/` in dev and of `dist/` once built, so the same relative
   path works whether the server runs via `tsx src/main.ts` or as the
   published `dist/main.js`. `data/` is generated and already gitignored
   (present in the root `.gitignore` since the repo's first commit).

2. **Make `@kata/docs-mcp` genuinely publishable**, mirroring `katajs`'s
   existing (unpublished-but-ready) shape: no `private` field, `bin` pointing
   at `dist/main.js`, `files: [dist, data, README.md]`,
   `publishConfig.access: public`, a `tsup` build (bare `tsc` would emit
   extensionless imports Node's ESM loader can't resolve — same reasoning as
   `packages/kata/tsup.config.ts`). The actual `npm publish` remains a manual
   step for the repo owner, same as `katajs` itself.

3. **Add `kata init --with-docs-mcp`** — a flag, not a prompt, consistent
   with the CLI's existing non-interactive design. It writes `.mcp.json`:
   ```json
   { "mcpServers": { "kata-docs": { "command": "npx", "args": ["-y", "@kata/docs-mcp"] } } }
   ```
   `onlyIfAbsent`, like the other generated manifests — a real project's
   `.mcp.json` may already register other servers. The CLI's next-steps
   output warns that this requires `@kata/docs-mcp` to actually be published
   first.

## Alternatives considered

### A — Interactive prompt ("seletor") in `kata init`
Rejected for now. No prompt library exists in the repo; introducing one is a
larger UX decision (backward compatibility for scripted/CI invocations of
`kata init`, a new dependency) than this feature justifies on its own. A
flag achieves the same opt-in outcome without it. Revisit if `kata init`
grows enough optional features that flags stop scaling.

### B — Host docs-mcp as a remote/hosted service
Rejected. Contradicts ADR-0022's "local first" decision outright — a hosted
server is a different trust and latency model, not a distribution detail.

### C — Keep docs-mcp monorepo-internal only, don't wire `kata init` at all
Rejected as the long-term answer, though it was the state before this ADR.
Kata's core thesis is being developed *with* AI assistance at low adoption
([[kata-framework]]) — leaving the docs-search tool undiscoverable by
generated apps directly undercuts that thesis. Kept as the fallback if npm
publishing turns out to be blocked for some reason.

## Consequences

### Positive
- `@kata/docs-mcp` works identically in dev (`tsx`) and once published
  (`npx @kata/docs-mcp`) — verified by running the compiled `dist/main.js`
  standalone via plain `node`, no tsx/TypeScript required.
- `kata init --with-docs-mcp` costs nothing to users who don't pass it —
  purely additive, `onlyIfAbsent`.
- No new runtime dependency in the framework itself — this only touches the
  CLI's generator layer and a sibling tooling package.

### Negative / costs
- The bundled `data/docs` snapshot is frozen at whatever version of
  `@kata/docs-mcp` a consumer's `npx` resolves — republishing is required to
  pick up doc changes. Acceptable: this is normal for any versioned package.
- `.mcp.json` written by `--with-docs-mcp` is inert until `@kata/docs-mcp` is
  actually published — a real, current gap this ADR does not close by
  itself.

### Follow-ups
- Actually `npm publish @kata/docs-mcp` (manual, repo owner) — until then
  `--with-docs-mcp` ships forward-looking config only.
- Consider whether `@kata/docs-mcp` should instead ship inside `katajs`
  itself (a subpath export) rather than as a separate package, once real
  usage data exists.

## Companion rules

None. This ADR governs CLI scaffolding output and external tooling
packaging, not application code inside generated Kata projects — no
`archgate` rule applies.

---
Numbering note: confirmed against `origin/main` on 2026-08-19 — max ADR on
`origin/main` is `0021`; this session's own ADR-0022 (docs-mcp lexical
search) is only in open PR #225, not yet merged. `0023` is the real next
number *given that PR merges first*; a same-branch-name PR (#224) already
merged once mid-session without conflict (see
[[kata-adr-numbering-collision]]), so reconfirm against `origin/main` right
before applying regardless of this note.
