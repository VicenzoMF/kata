import type { SerializedError } from './errors'
import type { Registry, Singleton } from './types'

// ────────────────────────────────────────────────────────────────────────────
// Central request logging (issue #63)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The `extra` payload a {@link Logger} method receives. Open — a handler or
 * middleware can log whatever fields it wants — except for the reserved `err`
 * key: when the framework logs an unhandled error (issue #210) it is always a
 * {@link SerializedError}, never a raw `Error`, so a naive
 * `JSON.stringify`-based logger cannot lose `message`/`stack` to `Error`'s
 * non-enumerable properties.
 */
export type LogExtra = Record<string, unknown> & { err?: SerializedError }

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
  info(message: string, extra?: LogExtra): void
  warn?(message: string, extra?: LogExtra): void
  error?(message: string, extra?: LogExtra): void
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
  const extra: LogExtra = { requestId, method, path, status, durationMs }
  if (status >= 500 && logger.error) {
    logger.error(message, extra)
  } else if (status >= 400 && logger.warn) {
    logger.warn(message, extra)
  } else {
    logger.info(message, extra)
  }
}

/**
 * Emit one framework-internal diagnostic — an unhandled error or an output
 * mismatch — through the app's `logger.error`, falling back to `console.error`
 * when no logger is registered. The single call site every such diagnostic
 * goes through (issue #210), so the fallback and the reserved-key shape can
 * never drift between them.
 */
export function logFrameworkError(
  logger: Logger | undefined,
  message: string,
  extra: LogExtra,
): void {
  if (logger?.error) {
    logger.error(message, extra)
  } else {
    console.error(message, extra)
  }
}
