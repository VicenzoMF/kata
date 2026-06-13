// ────────────────────────────────────────────────────────────────────────────
// Output validation mode (issue #17, ADR-0009)
// ────────────────────────────────────────────────────────────────────────────

/**
 * How an output-schema mismatch is handled (ADR-0009):
 * - `strict` — log the issues and return a 500 envelope (the response body is
 *   never allowed to violate its declared `output` schema). Dev / CI default.
 * - `log` — log the issues but send the handler's data through unchanged.
 *   Production default: a benign drift keeps serving instead of 500-ing.
 * - `off` — skip output validation entirely (no `safeParse`, no Zod transform).
 */
export type OutputValidationMode = 'strict' | 'log' | 'off'

const MODES: readonly OutputValidationMode[] = ['strict', 'log', 'off']

/**
 * Resolve the effective mode (ADR-0009), first match wins:
 * 1. the explicit `configured` value from `createApp`,
 * 2. the `KATA_OUTPUT_VALIDATION` env var when it names a valid mode,
 * 3. derived from `NODE_ENV` — `production` → `log`, otherwise `strict`.
 *
 * Pure: `env` is injected (defaulting to the ambient process env) so the
 * resolution is unit-testable without touching the real environment.
 */
export function resolveOutputValidationMode(
  configured: OutputValidationMode | undefined,
  env: Record<string, string | undefined> = readEnv(),
): OutputValidationMode {
  if (configured) return configured
  const fromEnv = env['KATA_OUTPUT_VALIDATION']
  if (isMode(fromEnv)) return fromEnv
  return env['NODE_ENV'] === 'production' ? 'log' : 'strict'
}

function isMode(value: string | undefined): value is OutputValidationMode {
  return value !== undefined && (MODES as readonly string[]).includes(value)
}

/**
 * Read the ambient environment without assuming `process` exists — kata runs on
 * edge runtimes (Workers, Deno) where it may be absent. Avoids an `any` cast by
 * narrowing `globalThis` to an optional `process.env` shape.
 */
function readEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env ?? {}
}
