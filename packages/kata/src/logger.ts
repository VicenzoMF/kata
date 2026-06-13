import type { Registry, Singleton } from './types'

// ────────────────────────────────────────────────────────────────────────────
// Central request logging (issue #63)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal structured logger the request pipeline writes to. A `singleton`
 * registered under the `logger` key in `defineContext` that satisfies this
 * shape is picked up automatically for per-request logging.
 *
 * Only `info` is required. `warn` / `error` are used for 4xx / 5xx responses
 * when present and fall back to `info` otherwise, so a one-method logger still
 * works.
 */
export type Logger = {
  info(message: string, extra?: Record<string, unknown>): void
  warn?(message: string, extra?: Record<string, unknown>): void
  error?(message: string, extra?: Record<string, unknown>): void
}

/**
 * Resolve the request logger from the DI registry: the value of a `logger`
 * singleton slot, but only if it actually looks like a {@link Logger}. Returns
 * `undefined` when no usable logger is registered, in which case request
 * logging is a silent no-op (the pipeline never invents its own logger).
 */
export function resolveLogger(registry: Registry): Logger | undefined {
  const slot = registry['logger']
  if (!slot || slot.__kind !== 'singleton') return undefined
  const value = (slot as Singleton<unknown>).__value
  return isLogger(value) ? value : undefined
}

function isLogger(value: unknown): value is Logger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { info?: unknown }).info === 'function'
  )
}

/** The fields logged for every request: method, path, status, duration, id. */
export type RequestLogFields = {
  requestId: string
  method: string
  path: string
  status: number
  durationMs: number
}

/**
 * Emit one structured line for a completed request. The level tracks the status
 * class — `error` for 5xx, `warn` for 4xx, `info` otherwise — degrading to
 * `info` when the logger does not implement the richer level.
 */
export function logRequest(logger: Logger, fields: RequestLogFields): void {
  const { requestId, method, path, status, durationMs } = fields
  const message = `${method} ${path} ${status} ${durationMs}ms`
  const extra: Record<string, unknown> = { requestId, method, path, status, durationMs }
  if (status >= 500 && logger.error) {
    logger.error(message, extra)
  } else if (status >= 400 && logger.warn) {
    logger.warn(message, extra)
  } else {
    logger.info(message, extra)
  }
}
