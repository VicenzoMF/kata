---
"@katajs-framework/docs-mcp": patch
---

Rebundles `docs/{guide,cookbook,reference,adr}` to pick up the fixes closing
the 0.4.1 docs-only POC report plus a follow-up sweep: a runnable first
command in `guide/cli.md` and `README.md` for both npx and pnpm bootstraps,
the `$get()`/all-optional-input calling convention in `guide/rpc-client.md`,
the `.test.ts`-drops-from-`kata verify` interaction in
`guide/project-layout.md` and `guide/errors.md`, the non-envelope-schema
behind a declared 4xx interaction in `guide/errors.md`, a singleton-reset
seam for HTTP-level tests in `cookbook/database.md`, restored missing
`docs/pt` sections (`raw()` in `routes-schemas.md`, the DI/IoC intro in
`context-di.md`), and pre-rename `kata`/`kata/jwt`/`kata/node` import paths
fixed across five ADR code samples.
