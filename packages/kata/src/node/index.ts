// `kata/node` — the Node-only entry. This is the *only* place in the package
// that touches `node:process` or the Node server type, so importing the
// runtime-neutral root (`kata`) from an edge/Workers build never pulls in
// `node:process` (ADR-0014 "Adapter scope"; ADR-0001).
import type { Server } from 'node:http'
import type { Http2SecureServer, Http2Server } from 'node:http2'

/**
 * The handle `@hono/node-server`'s `serve()` returns: a `node:http` /
 * `node:http2` server that owns the listening socket and the in-flight
 * connections. Structurally identical to `@hono/node-server`'s own
 * `ServerType`, re-derived here from `@types/node` so `kata/node` needs only
 * `@types/node` and never bundles the adapter into Kata's core. The helper
 * takes the *server*, not the Kata `app`: the app is the request handler, the
 * server is the thing that owns the socket and must be `close()`d to drain.
 */
export type ServerType = Server | Http2Server | Http2SecureServer

export type GracefulShutdownOptions = {
  /**
   * App-owned teardown, run *after* the in-flight drain so no live handler
   * loses its pool or transaction mid-query. Sequence resource closing here —
   * Kata owns no dispose registry; teardown order is the app's (ADR-0014).
   */
  onClose: () => void | Promise<void>
  /**
   * Signals to trap. Defaults to `['SIGTERM', 'SIGINT']` — the orchestrator's
   * graceful-stop signal plus Ctrl-C in a dev terminal.
   */
  signals?: readonly NodeJS.Signals[]
  /**
   * Soft deadline for the drain + `onClose`. If exceeded, the process
   * force-exits non-zero. Defaults to `10_000` ms; keep it below the
   * orchestrator's grace period so we beat the uncatchable `SIGKILL`
   * (ADR-0014 "Drain semantics").
   */
  timeoutMs?: number
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Trap termination signals and drain a Node server gracefully (ADR-0014).
 *
 * On the **first** trapped signal, in order:
 *
 * 1. guard re-entry — a second signal while shutting down is ignored, so the
 *    routine is idempotent / double-signal safe;
 * 2. arm an `unref`'d `setTimeout(() => process.exit(1), timeoutMs)` escape hatch;
 * 3. `server.close()` — stop accepting new connections; in-flight requests run
 *    to completion;
 * 4. await the in-flight drain (the `server.close(cb)` completion);
 * 5. `await onClose()` — strictly *after* the drain;
 * 6. `process.exit(0)` on clean completion.
 *
 * If the drain + `onClose` exceed `timeoutMs`, the timer fires first and the
 * process force-exits with a non-zero code (in-flight work abandoned — a
 * distinct, visible outcome for the orchestrator).
 *
 * Opt in from `main.ts`; `createApp` installs no signal handlers (ADR-0014
 * "Signals and the framework / `main.ts` boundary"). The same `process.on`
 * listener stays registered across the shutdown so a second signal is caught
 * and swallowed by the re-entry guard rather than hitting Node's default
 * (terminating) handler.
 */
export function gracefulShutdown(server: ServerType, options: GracefulShutdownOptions): void {
  const signals = options.signals ?? DEFAULT_SIGNALS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let shuttingDown = false

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return // (1) re-entry guard — a second signal is swallowed
    }
    shuttingDown = true

    // (2) Force-exit escape hatch. `unref` so the timer itself never keeps the
    // event loop alive once the drain has finished.
    const forceExit = setTimeout(() => process.exit(1), timeoutMs)
    forceExit.unref()

    try {
      await closeServer(server) // (3) + (4) stop accepting, await in-flight drain
      await options.onClose() // (5) app teardown, strictly after the drain
      process.exit(0) // (6) clean shutdown within budget
    } catch {
      // Drain or teardown failed — abandon and surface a non-zero exit rather
      // than report a clean stop.
      process.exit(1)
    } finally {
      clearTimeout(forceExit)
    }
  }

  for (const signal of signals) {
    process.on(signal, shutdown)
  }
}

/**
 * Resolve once the server has stopped accepting and every in-flight connection
 * has drained; reject if `close` reports an error (e.g. the server was never
 * listening), which the caller treats as an unclean shutdown.
 */
function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}
