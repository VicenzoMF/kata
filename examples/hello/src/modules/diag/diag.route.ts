import { defineRoute } from '../../context'

import { RequestIdResponseSchema } from './diag.schema'

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
