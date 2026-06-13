// ────────────────────────────────────────────────────────────────────────────
// Request correlation id (issue #63)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Header used both to read an inbound correlation id and to echo the resolved
 * one back on the response. Lower-case to match Hono's normalised header names.
 */
export const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Constrains an inbound request id to a safe character set and length. Covers
 * UUIDs and W3C trace ids (hex, `-`, `_`, `.`, `:`) while keeping newlines and
 * other control characters — the vector for log- and header-injection — out.
 */
const SAFE_REQUEST_ID = /^[\w.:-]{1,200}$/

/**
 * Resolve the correlation id for a request: reuse a well-formed inbound
 * `x-request-id` (so an id assigned at an edge proxy / gateway flows through
 * unchanged), otherwise mint a fresh UUID. A malformed or oversized inbound
 * value is ignored in favour of a generated id rather than trusted.
 */
export function resolveRequestId(inbound: string | undefined): string {
  if (inbound) {
    const trimmed = inbound.trim()
    if (SAFE_REQUEST_ID.test(trimmed)) return trimmed
  }
  return crypto.randomUUID()
}
