import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWatchSession, watchProject } from './watch'

let dir: string

function write(rel: string, text: string): string {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text)
  return full
}

const CONTEXT = `import { defineContext, scoped, singleton } from 'katajs'
export const k = defineContext({
  logger: singleton({ info() {} }),
  currentUser: scoped(),
})`

const CONTEXT_NO_LOGGER = `import { defineContext, scoped } from 'katajs'
export const k = defineContext({ currentUser: scoped() })`

const CLEAN_ROUTE = `import { defineRoute } from '../../context'
export const r = defineRoute({
  method: 'GET', path: '/x', input: {}, output: S, handler: () => null,
})`

const MISSING_OUTPUT = `import { defineRoute } from '../../context'
export const r = defineRoute({ method: 'GET', path: '/x', input: {}, handler: () => null })`

const READS_LOGGER = `import { defineRoute } from '../../context'
export const r = defineRoute({
  method: 'GET', path: '/x', input: {}, output: S, handler: (c) => c.get('logger'),
})`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kata-watch-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createWatchSession()', () => {
  it('verifies the initial project from disk', () => {
    write('src/context.ts', CONTEXT)
    write('src/modules/x/x.route.ts', CLEAN_ROUTE)
    const session = createWatchSession(dir)
    expect(session.verify().errorCount).toBe(0)
  })

  it('re-reads the changed file and picks up a new violation', () => {
    write('src/context.ts', CONTEXT)
    const routePath = write('src/modules/x/x.route.ts', CLEAN_ROUTE)
    const session = createWatchSession(dir)
    expect(session.verify().errorCount).toBe(0)

    writeFileSync(routePath, MISSING_OUTPUT)
    const result = session.update(routePath)
    expect(result.errorCount).toBe(1)
    expect(result.issues[0]?.rule).toBe('kata/no-route-without-output-schema')
  })

  it('refreshes only the file named in update() (incremental)', () => {
    write('src/context.ts', CONTEXT)
    const aPath = write('src/modules/a/a.route.ts', CLEAN_ROUTE)
    const bPath = write('src/modules/b/b.route.ts', CLEAN_ROUTE)
    const session = createWatchSession(dir)

    // Break both files on disk, but only notify the session about A.
    writeFileSync(aPath, MISSING_OUTPUT)
    writeFileSync(bPath, MISSING_OUTPUT)
    const result = session.update(aPath)

    // B's change is not read until B itself is reported changed.
    expect(result.errorCount).toBe(1)
    expect(result.issues[0]?.file).toContain('a.route.ts')
  })

  it('recomputes the registry when context.ts changes', () => {
    const contextPath = write('src/context.ts', CONTEXT)
    write('src/modules/x/x.route.ts', READS_LOGGER)
    const session = createWatchSession(dir)
    expect(session.verify().errorCount).toBe(0)

    // Dropping `logger` from the registry makes the route's c.get('logger') unregistered.
    writeFileSync(contextPath, CONTEXT_NO_LOGGER)
    const result = session.update(contextPath)
    expect(result.errorCount).toBe(1)
    expect(result.issues[0]?.rule).toBe('kata/context-key-not-registered')
  })

  it('drops a file from the project when it is deleted', () => {
    write('src/context.ts', CONTEXT)
    const routePath = write('src/modules/x/x.route.ts', MISSING_OUTPUT)
    const session = createWatchSession(dir)
    expect(session.verify().errorCount).toBe(1)

    unlinkSync(routePath)
    expect(session.update(routePath).errorCount).toBe(0)
  })

  it('picks up a newly added file', () => {
    write('src/context.ts', CONTEXT)
    write('src/modules/x/x.route.ts', CLEAN_ROUTE)
    const session = createWatchSession(dir)
    expect(session.verify().errorCount).toBe(0)

    const added = write('src/modules/y/y.route.ts', MISSING_OUTPUT)
    expect(session.update(added).errorCount).toBe(1)
  })
})

describe('watchProject()', () => {
  it('renders initially and on each change, and stops cleanly', () => {
    write('src/context.ts', CONTEXT)
    const routePath = write('src/modules/x/x.route.ts', CLEAN_ROUTE)

    const renders: { changed: string | null; errorCount: number }[] = []
    let closed = false
    let listener: ((event: string, filename: string | null) => void) | undefined

    const stop = watchProject(dir, {
      debounceMs: 0,
      watch: (_dir, _opts, l) => {
        listener = l
        return {
          close() {
            closed = true
          },
        }
      },
      render: (result, changed) => renders.push({ changed, errorCount: result.errorCount }),
    })

    // Initial render: whole project, no specific file changed.
    expect(renders).toHaveLength(1)
    expect(renders[0]).toEqual({ changed: null, errorCount: 0 })

    // A null filename event is ignored.
    listener?.('change', null)
    expect(renders).toHaveLength(1)

    // A real change re-checks and renders with the changed file's relative path.
    writeFileSync(routePath, MISSING_OUTPUT)
    listener?.('change', 'modules/x/x.route.ts')
    expect(renders).toHaveLength(2)
    expect(renders[1]?.errorCount).toBe(1)
    expect(renders[1]?.changed).toContain('x.route.ts')

    stop()
    expect(closed).toBe(true)
  })
})
