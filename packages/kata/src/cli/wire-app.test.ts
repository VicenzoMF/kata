import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeAppWiring, wireAppModule } from './wire-app'

const APP_SOURCE = `import { createApp } from './context'
import { requestLogger } from '../middlewares/request-logger'
import * as greetings from './modules/greetings/greetings.route'
import * as health from './modules/health/health.route'

export const app = createApp({
  modules: [health, greetings],
  middlewares: [requestLogger],
})
`

describe('computeAppWiring()', () => {
  it('inserts the import in sorted position and appends to modules', () => {
    const outcome = computeAppWiring(APP_SOURCE, 'orders')
    expect(outcome.status).toBe('wired')
    if (outcome.status !== 'wired') throw new Error('unreachable')
    expect(outcome.text).toContain("import * as orders from './modules/orders/orders.route'")
    expect(outcome.text).toContain('modules: [health, greetings, orders]')
    // The import is inserted after the last existing module import — sorted
    // (greetings < health < orders) — not appended blindly at file end.
    const healthIdx = outcome.text.indexOf('import * as health')
    const ordersIdx = outcome.text.indexOf('import * as orders')
    expect(ordersIdx).toBeGreaterThan(healthIdx)
  })

  it('inserts before an existing import when it sorts earlier', () => {
    const outcome = computeAppWiring(APP_SOURCE, 'auth')
    expect(outcome.status).toBe('wired')
    if (outcome.status !== 'wired') throw new Error('unreachable')
    const authIdx = outcome.text.indexOf('import * as auth')
    const greetingsIdx = outcome.text.indexOf('import * as greetings')
    expect(authIdx).toBeLessThan(greetingsIdx)
    expect(outcome.text).toContain('modules: [health, greetings, auth]')
  })

  it('is idempotent: a domain already in the modules array is a no-op', () => {
    const first = computeAppWiring(APP_SOURCE, 'orders')
    if (first.status !== 'wired') throw new Error('unreachable')

    const second = computeAppWiring(first.text, 'orders')
    expect(second).toEqual({ status: 'already-wired' })
  })

  it('appends into an empty modules array without a leading comma', () => {
    const source = `import { createApp } from './context'

export const app = createApp({
  modules: [],
})
`
    const outcome = computeAppWiring(source, 'orders')
    expect(outcome.status).toBe('wired')
    if (outcome.status !== 'wired') throw new Error('unreachable')
    expect(outcome.text).toContain('modules: [orders]')
  })

  it('bails to unrecognized when there is no createApp({ modules }) call', () => {
    const outcome = computeAppWiring('export const x = 1\n', 'orders')
    expect(outcome.status).toBe('unrecognized')
    if (outcome.status !== 'unrecognized') throw new Error('unreachable')
    expect(outcome.pasteLines[0]).toContain(
      "import * as orders from './modules/orders/orders.route'",
    )
  })

  it('bails to unrecognized when modules is not a literal array', () => {
    const source = `import { createApp } from './context'
const mods = [health]
export const app = createApp({ modules: mods })
`
    expect(computeAppWiring(source, 'orders').status).toBe('unrecognized')
  })

  it('bails to unrecognized on two createApp({ modules }) calls (ambiguous)', () => {
    const source = `import { createApp } from './context'
export const app = createApp({ modules: [health] })
export const other = createApp({ modules: [greetings] })
`
    expect(computeAppWiring(source, 'orders').status).toBe('unrecognized')
  })
})

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kata-wire-app-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('wireAppModule()', () => {
  it('writes the wired src/app.ts back to disk', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src/app.ts'), APP_SOURCE, 'utf8')

    const outcome = await wireAppModule(dir, 'orders')

    expect(outcome.status).toBe('wired')
    const written = await readFile(join(dir, 'src/app.ts'), 'utf8')
    expect(written).toContain('modules: [health, greetings, orders]')
  })

  it('reports missing (and does not throw) when src/app.ts does not exist', async () => {
    const outcome = await wireAppModule(dir, 'orders')
    expect(outcome.status).toBe('missing')
    if (outcome.status !== 'missing') throw new Error('unreachable')
    expect(outcome.pasteLines.length).toBeGreaterThan(0)
  })

  it('does not rewrite the file on a second, already-wired run', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src/app.ts'), APP_SOURCE, 'utf8')
    await wireAppModule(dir, 'orders')
    const before = await readFile(join(dir, 'src/app.ts'), 'utf8')

    const second = await wireAppModule(dir, 'orders')

    expect(second.status).toBe('already-wired')
    expect(await readFile(join(dir, 'src/app.ts'), 'utf8')).toBe(before)
  })
})
