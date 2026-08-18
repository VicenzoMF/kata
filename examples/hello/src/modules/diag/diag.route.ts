import { defineRoute } from '../../context'

import { ExportCsvOutputSchema, RequestIdResponseSchema } from './diag.schema'

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
 */
export const exportCsvRoute = defineRoute({
  method: 'GET',
  path: '/export.csv',
  input: {},
  output: ExportCsvOutputSchema,
  handler: () =>
    new Response('id,name\n1,Ada Lovelace\n2,Grace Hopper\n', {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="export.csv"',
      },
    }),
})
