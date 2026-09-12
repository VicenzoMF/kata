# @katajs-framework/docs-mcp

## 0.1.6

### Patch Changes

- 675e233: Rebundles `docs/{guide,cookbook,reference,adr}` so the published snapshot
  carries the documentation fixes merged after `0.1.5`: `requireRole` examples
  wrapped in `defineMiddleware` so they typecheck (`guide/jwt.md`,
  `cookbook/auth.md`, `reference/jwt.md`, `reference/middleware.md`), and the six
  consumer-feedback gaps found against `@katajs-framework/core@0.4.2` —
  registration-order path matching, the fixed non-configurable 422 validation
  status, `z.array(...)` as a valid `output` entry, `use:` short-circuit ordering
  (413 before 401), the error-union link from `guide/project-layout.md`, and the
  HTTP-level test suite moved out of `cookbook/database.md`. Also corrects the
  `invalid_enum_value` envelope in `guide/errors.md` and
  `reference/define-route.md` to include the `received` field Zod actually emits.

## 0.1.5

### Patch Changes

- db73505: Rebundles `docs/{guide,cookbook,reference,adr}` to pick up the fixes closing
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
