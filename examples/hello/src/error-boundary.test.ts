import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createApp, defineRoute } from './context'

// Kata's global error boundary (docs/guide/errors.md#uncaught-throws-internal-error)
// turns any throw that escapes a handler into the unified `internal_error` 500
// envelope. Exercising that path needs a route that always throws — but a route
// like that must never live on the app surface `main.ts` actually serves, or it
// becomes a standing "crash the server" endpoint reachable in production
// (issue #247, DOC-FEEDBACK #252).
//
// The pattern: define the throwing route here, in the test file, and build a
// throwaway app from it with the app's own `createApp`/`defineRoute` — the same
// factory `main.ts` uses, wired to the same registry (`./context`) — so the
// exact production middleware pipeline and error-boundary code run. `main.ts`'s
// `modules: [users, auth, echo, diag]` array is never touched: this route is not
// a module export, it exists only inside this file's module scope, and the app
// built from it is thrown away at the end of the test.
const crashRoute = defineRoute({
  method: 'GET',
  path: '/__test-only/boom',
  input: {},
  output: z.object({ ok: z.boolean() }),
  handler: () => {
    throw new Error('forced failure — error-boundary test only')
  },
})

describe('error boundary (issue #247): forcing a 500 without a shipped crash route', () => {
  it('turns a thrown handler error into the unified internal_error envelope', async () => {
    // hello's example logger (./context.ts) only implements `info`, so the
    // framework's `logFrameworkError` falls back to `console.error` for this
    // unhandled throw (see packages/kata/src/logger.ts). Silence it so the test
    // output stays clean — a real logger with `.error` would just receive the
    // structured line instead.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Built from *only* the test-local route — `users`, `auth`, `echo`, and
    // `diag` (the modules `main.ts` actually serves) are never imported here.
    const app = createApp({ modules: [{ crashRoute }] })
    const res = await app.request('/__test-only/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Internal server error',
    })

    consoleError.mockRestore()
  })
})
