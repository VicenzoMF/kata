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

/**
 * `/boom`'s handler always throws, so this shape is never actually returned —
 * it exists only to satisfy the mandatory `output` schema (ADR-0003). Mirrors
 * the throwaway route in `error-boundary.test.ts`.
 */
export const BoomOutputSchema = z.object({ ok: z.boolean() })
