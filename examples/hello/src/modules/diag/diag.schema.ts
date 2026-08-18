import { z } from 'zod'

export const RequestIdResponseSchema = z.object({
  requestId: z.string(),
})

export type RequestIdResponse = z.infer<typeof RequestIdResponseSchema>

/**
 * Placeholder for `/export.csv` (issue #207): the handler returns a raw
 * `Response`, not `c.json`, so output validation never actually runs against
 * this schema — the route bypasses it by design (ADR-0011/ADR-0003, single
 * schema form). It exists so the route still declares an `output` per
 * AGENTS.md's "every route declares input and output schemas".
 */
export const ExportCsvOutputSchema = z.string()
