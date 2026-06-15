import { afterEach, describe, expect, it, vi } from 'vitest'

import { type GracefulShutdownOptions, gracefulShutdown, type ServerType } from './index'

type AnyHandler = (...args: unknown[]) => unknown

const DEFAULT_TRAPPED: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT']

// (signal, handler) pairs registered during a test, so afterEach removes
// exactly those — never touching listeners owned by the test runner.
const registered: Array<{ signal: NodeJS.Signals; handler: AnyHandler }> = []

afterEach(() => {
  for (const { signal, handler } of registered) {
    process.removeListener(signal, handler as unknown as NodeJS.SignalsListener)
  }
  registered.length = 0
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Call gracefulShutdown, then hand back the freshly-registered handler so the
// test can invoke the drain routine directly — no real signal needed (ADR-0014).
// Capturing it from `process.listeners` also proves the handler was registered.
function arm(server: ServerType, options: GracefulShutdownOptions): () => Promise<void> {
  const signals = options.signals ?? DEFAULT_TRAPPED
  const before = new Map<NodeJS.Signals, number>()
  for (const signal of signals) {
    before.set(signal, process.listeners(signal).length)
  }

  gracefulShutdown(server, options)

  let invoker: AnyHandler | undefined
  for (const signal of signals) {
    const listeners = process.listeners(signal)
    for (let i = before.get(signal) ?? 0; i < listeners.length; i += 1) {
      const handler = listeners[i] as unknown as AnyHandler
      registered.push({ signal, handler })
      invoker ??= handler
    }
  }

  if (!invoker) {
    throw new Error('gracefulShutdown registered no signal handler')
  }
  const handler = invoker
  return () => Promise.resolve(handler()) as Promise<void>
}

// A controllable stand-in for the node:http server: only `close(cb)` is used.
// The drain stays pending until the test calls `finishDrain`, so the
// drain → onClose → exit ordering is fully deterministic.
function fakeServer() {
  let drainCallback: ((err?: Error) => void) | undefined
  let closeCount = 0
  const server = {
    close(callback?: (err?: Error) => void): void {
      closeCount += 1
      drainCallback = callback
    },
  }
  return {
    server: server as unknown as ServerType,
    get closeCount() {
      return closeCount
    },
    finishDrain(err?: Error) {
      if (!drainCallback) {
        throw new Error('server.close has not been called yet')
      }
      drainCallback(err)
    },
  }
}

// Stub process.exit so the routine can be driven to completion in-process;
// returns the array of codes it was called with.
function mockExit(): number[] {
  const codes: number[] = []
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    codes.push(typeof code === 'number' ? code : 0)
    return undefined as never
  })
  return codes
}

describe('gracefulShutdown()', () => {
  it('registers a handler on the configured signal', () => {
    const { server } = fakeServer()
    const before = process.listeners('SIGUSR2').length
    arm(server, { onClose: vi.fn(), signals: ['SIGUSR2'] })
    expect(process.listeners('SIGUSR2').length).toBe(before + 1)
  })

  it('defaults to trapping SIGTERM and SIGINT', () => {
    const { server } = fakeServer()
    arm(server, { onClose: vi.fn() })
    const trapped = registered.map((entry) => entry.signal)
    expect(trapped).toContain('SIGTERM')
    expect(trapped).toContain('SIGINT')
  })

  it('stops accepting, drains, then runs onClose, then exits 0', async () => {
    const exits = mockExit()
    const srv = fakeServer()
    const onClose = vi.fn()
    const trigger = arm(srv.server, { onClose, signals: ['SIGUSR2'], timeoutMs: 10_000 })

    const done = trigger()
    // server.close() runs synchronously; onClose must wait for the drain.
    expect(srv.closeCount).toBe(1)
    expect(onClose).not.toHaveBeenCalled()

    srv.finishDrain()
    await done

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([0])
  })

  it('is idempotent — a second signal during shutdown is ignored', async () => {
    const exits = mockExit()
    const srv = fakeServer()
    const onClose = vi.fn()
    const trigger = arm(srv.server, { onClose, signals: ['SIGUSR2'], timeoutMs: 10_000 })

    const first = trigger()
    const second = trigger() // re-entry while the first drain is in flight
    srv.finishDrain()
    await Promise.all([first, second])

    expect(srv.closeCount).toBe(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([0])
  })

  it('force-exits non-zero when the drain exceeds timeoutMs', () => {
    vi.useFakeTimers()
    const exits = mockExit()
    const srv = fakeServer()
    const onClose = vi.fn()
    const trigger = arm(srv.server, { onClose, signals: ['SIGUSR2'], timeoutMs: 10_000 })

    void trigger() // drain never completes — finishDrain is never called
    expect(srv.closeCount).toBe(1)
    expect(exits).toEqual([])

    vi.advanceTimersByTime(10_000)

    expect(exits).toEqual([1])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('force-exits non-zero when onClose rejects', async () => {
    const exits = mockExit()
    const srv = fakeServer()
    const onClose = vi.fn(() => Promise.reject(new Error('teardown failed')))
    const trigger = arm(srv.server, { onClose, signals: ['SIGUSR2'], timeoutMs: 10_000 })

    const done = trigger()
    srv.finishDrain()
    await done

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])
  })
})
