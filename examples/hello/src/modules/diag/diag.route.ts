import { raw } from '@katajs-framework/core'

import { defineRoute } from '../../context'

import { BoomOutputSchema, ExportCsvOutputSchema, RequestIdResponseSchema } from './diag.schema'

/**
 * Surfaces the per-request correlation id (issue #63) that the runtime places on
 * the kata context as `c.requestId`. The same id is echoed on the
 * `x-request-id` response header and recorded in the per-request log line, so a
 * caller can correlate a response with its server-side logs.
 */
export const requestIdRoute = defineRoute({
  method: 'GET',
  path: '/request-id',
  input: {},
  output: RequestIdResponseSchema,
  handler: (c) => ({ requestId: c.requestId }),
})

/**
 * A non-JSON route (issue #207): the handler returns `new Response(...)`
 * directly instead of `c.json`/`c.error`, the one return path that used to
 * drop every app-level response header — `main.ts`'s `[cors(), secureHeaders(),
 * bodyLimit()]` chain never reached it. Demonstrates that it now does, plus
 * the correlation id and a handler-set `content-type` surviving alongside it.
 *
 * `output` declares `raw('text/csv', ...)` (ADR-0024, issue #208) instead of a
 * plain schema: a plain `output: ExportCsvOutputSchema` would make the
 * `Response` return below a `tsc` error, and — before ADR-0024 — silently
 * skipped validating it entirely, exactly the bug issue #208 fixed. Under
 * `strict` (the default outside production), the content-type and body are
 * now genuinely checked against this declaration.
 */
export const exportCsvRoute = defineRoute({
  method: 'GET',
  path: '/export.csv',
  input: {},
  output: raw('text/csv', ExportCsvOutputSchema),
  handler: () =>
    new Response('id,name\n1,Ada Lovelace\n2,Grace Hopper\n', {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="export.csv"',
      },
    }),
})

/**
 * A standing, production-reachable crash endpoint — by design (issue #297).
 *
 * `error-boundary.test.ts` covers Kata's global error boundary with a route
 * defined *only inside the test file*, so it never binds a port and is
 * unreachable from an out-of-process tool. That's the right call for a Vitest
 * assertion, but it can't satisfy an E2E suite over real HTTP (Hurl, curl,
 * Playwright, …): those tools can only hit a route that's actually part of
 * the server `main.ts` boots, i.e. something in the real `modules` array.
 *
 * There is no way to get "a path that forces a 500, reachable from real HTTP"
 * without that path being reachable from real HTTP — including in
 * production. This route accepts that trade-off explicitly instead of
 * leaving it to be rediscovered: it lives in the `diag` module (already
 * diagnostics-flavored, already wired into `main.ts`), does nothing but
 * throw, and is asserted end to end in `diag.hurl`. See
 * "Testing the error boundary over real HTTP" in `cookbook/errors.md` for the
 * full reasoning.
 */
export const boomRoute = defineRoute({
  method: 'GET',
  path: '/boom',
  input: {},
  output: BoomOutputSchema,
  handler: () => {
    throw new Error(
      'forced failure — diag.boom is a standing crash route for real-HTTP E2E coverage',
    )
  },
})
