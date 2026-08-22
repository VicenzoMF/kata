import { z } from 'zod'

export const RequestIdResponseSchema = z.object({
  requestId: z.string(),
})

export type RequestIdResponse = z.infer<typeof RequestIdResponseSchema>

/**
 * The CSV body for `/export.csv` (issue #207, ADR-0024/issue #208): paired
 * with `raw('text/csv', ...)` in the route, so — unlike a plain schema, which
 * a `Response` return used to bypass entirely — this schema is genuinely
 * validated (as text) whenever output validation runs in `strict` mode.
 */
export const ExportCsvOutputSchema = z.string()
