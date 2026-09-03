---
"@katajs-framework/docs-mcp": patch
---

Rebundles `docs/{guide,cookbook,reference,adr}` so the published snapshot
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
