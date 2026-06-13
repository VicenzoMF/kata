import { z } from 'zod'

export type FieldIssue = {
  path: string
  message: string
  code: string
  expected?: unknown
  received?: unknown
}

/**
 * Zod mirror of {@link FieldIssue} (ADR-0011). Used to compose
 * {@link ErrorBodySchema}; declare it behind an error status in a route's
 * `output` map when the structured-issues shape matters.
 */
export const FieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
  expected: z.unknown().optional(),
  received: z.unknown().optional(),
})

/** Structured field errors, keyed by input source (params / query / body / headers). */
export type FieldIssues = Record<string, FieldIssue[]>

/**
 * The single shape every Kata 4xx/5xx response takes (ADR-0008).
 * - `error`   — stable, machine-readable code (e.g. `'not_found'`).
 * - `message` — human-readable description.
 * - `issues`  — present only when there are structured field errors.
 */
export type ErrorBody = {
  error: string
  message: string
  issues?: FieldIssues
}

/**
 * Zod schema for {@link ErrorBody} — the canonical thing to put behind a 4xx/5xx
 * status in a route's `output` map (ADR-0011), so the ADR-0008 envelope produced
 * by `c.error(...)` is both typed for the RPC client and runtime-validated.
 * `z.infer<typeof ErrorBodySchema>` is assignable to {@link ErrorBody}; an app
 * may substitute a stricter refinement (e.g. a literal `error` code) per route.
 */
export const ErrorBodySchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.record(z.string(), z.array(FieldIssueSchema)).optional(),
})

/** Optional extras for {@link buildErrorBody} / `c.error`. Closed and typed (ADR-0008, Alt. C). */
export type ErrorExtra = {
  /** HTTP status for the response. Defaults to 400. */
  status?: number
  /** Structured field errors to attach under `issues`. */
  issues?: FieldIssues
}

/**
 * Build the unified error envelope (ADR-0008). Pure and framework-agnostic —
 * the `Response` wrapping lives in `context.ts`. The `code` argument becomes
 * the wire field `error` (kept for back-compat; see ADR-0008).
 */
export function buildErrorBody(code: string, message: string, extra?: ErrorExtra): ErrorBody {
  const body: ErrorBody = { error: code, message }
  if (extra?.issues) body.issues = extra.issues
  return body
}

export function formatZodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => {
    const out: FieldIssue = {
      path: pathToDotNotation(issue.path),
      message: issue.message,
      code: issue.code,
    }
    if ('expected' in issue && issue.expected !== undefined) out.expected = issue.expected
    if ('received' in issue && issue.received !== undefined) out.received = issue.received
    return out
  })
}

function pathToDotNotation(path: ReadonlyArray<string | number>): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else if (out === '') {
      out = segment
    } else {
      out += `.${segment}`
    }
  }
  return out
}
