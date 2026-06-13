import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineContext } from './context'
import { ErrorBodySchema } from './errors'
import type { OutputValidationMode } from './output-validation'
import type { ModulesToHonoSchema } from './rpc'

const UserSchema = z.object({ id: z.string(), name: z.string() })
const CreatedSchema = z.object({ id: z.string() })

// ────────────────────────────────────────────────────────────────────────────
// Runtime — status→schema map validation (ADR-0011)
// ────────────────────────────────────────────────────────────────────────────

describe('multi-status output: plain return is the 200 body', () => {
  // The success (200) schema lives at output[200]; a plain return is validated
  // against it exactly as a single-schema route is (ADR-0003, ADR-0009).
  function appWith(mode: OutputValidationMode, handlerReturn: unknown) {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/u/:id',
      input: { params: z.object({ id: z.string() }) },
      output: { 200: UserSchema, 404: ErrorBodySchema },
      handler: () => handlerReturn as { id: string; name: string },
    })
    return k.createApp({ modules: [{ route }], outputValidation: mode, requestLogging: false })
  }

  it('validates a plain return against output[200] and sends 200', async () => {
    const res = await appWith('strict', { id: '7', name: 'Ada' }).request('/u/7')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: '7', name: 'Ada' })
  })

  it('strict: a plain return that mismatches output[200] becomes a 500 envelope', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith('strict', { id: 'a' }).request('/u/a') // missing `name`
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'internal_output_shape_mismatch',
      message: 'Response did not match the declared output schema',
    })
    expect(errSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('log: a plain mismatch is logged but the data passes through with 200', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await appWith('log', { id: 'a' }).request('/u/a')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'a' })
    expect(errSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('multi-status output: a Response is validated against output[status]', () => {
  it('validates a c.error envelope against the declared 4xx schema and passes it through (strict)', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/u/:id',
      input: { params: z.object({ id: z.string() }) },
      output: { 200: UserSchema, 404: ErrorBodySchema },
      handler: (c) => c.error('not_found', 'User not found', { status: 404 }),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/u/none')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found', message: 'User not found' })
    // The correlation id is still echoed on a passed-through Response (issue #63).
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('validates a non-200 success Response (c.json body, 201) against output[201] (strict)', async () => {
    const k = defineContext({})
    // No 200 entry: a plain return is `never`, so the handler must return a Response.
    const route = k.defineRoute({
      method: 'POST',
      path: '/things',
      input: {},
      output: { 201: CreatedSchema },
      handler: (c) => c.json({ id: 'x1' }, 201),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/things', { method: 'POST' })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'x1' })
  })

  it('strict: a Response body that mismatches its status schema becomes a 500', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/things',
      input: {},
      output: { 201: CreatedSchema },
      handler: (c) => c.json({ wrong: true }, 201),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/things', { method: 'POST' })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'internal_output_shape_mismatch',
      message: 'Response did not match the declared output schema',
    })
    expect(errSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('log: a declared-status Response mismatch is logged but the original is served', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/things',
      input: {},
      output: { 201: CreatedSchema },
      handler: (c) => c.json({ wrong: true }, 201),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'log',
      requestLogging: false,
    })
    const res = await app.request('/things', { method: 'POST' })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ wrong: true })
    expect(errSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('off: the map form skips Response validation entirely', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/things',
      input: {},
      output: { 201: CreatedSchema },
      handler: (c) => c.json({ wrong: true }, 201),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'off',
      requestLogging: false,
    })
    const res = await app.request('/things', { method: 'POST' })

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ wrong: true })
    expect(errSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('passes an undeclared status through unvalidated, even in strict', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/u',
      input: {},
      output: { 200: UserSchema },
      handler: (c) => c.json({ anything: 'goes' }, 418),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/u')

    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ anything: 'goes' })
  })

  it('skips validation for a non-JSON Response body, even when its status is declared', async () => {
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/raw',
      input: {},
      output: { 200: UserSchema },
      handler: () =>
        new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } }),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/raw')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('plain text')
  })
})

describe('multi-status output: single-schema back-compat', () => {
  it('a Response return still short-circuits output validation (unchanged from ADR-0003)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'POST',
      path: '/things',
      input: {},
      output: CreatedSchema, // single schema, not a map
      handler: (c) => c.json({ totally: 'wrong' }, 201),
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/things', { method: 'POST' })

    // Single-schema + Response = pass-through, never validated (no 500, nothing logged).
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ totally: 'wrong' })
    expect(errSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('a plain return is still validated against the single schema (strict 500 on mismatch)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const k = defineContext({})
    const route = k.defineRoute({
      method: 'GET',
      path: '/u',
      input: {},
      output: UserSchema,
      handler: () => ({ id: 'a' }) as { id: string; name: string }, // missing `name`
    })
    const app = k.createApp({
      modules: [{ route }],
      outputValidation: 'strict',
      requestLogging: false,
    })
    const res = await app.request('/u')

    expect(res.status).toBe(500)
    expect(errSpy).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Type-level — the RPC `Schema` derivation (ADR-0011 + epic #11)
//
// These aliases are checked by `tsc` (the package typecheck). A map route yields
// a per-status union of endpoints; a single schema stays one `status: 200`
// endpoint. Aggregated into one exported tuple so each proof is referenced.
// ────────────────────────────────────────────────────────────────────────────

const proofCtx = defineContext({})

const multiRoute = proofCtx.defineRoute({
  method: 'GET',
  path: '/u/:id',
  input: { params: z.object({ id: z.string() }) },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: (c) => c.error('not_found', 'nope', { status: 404 }),
})

const singleRoute = proofCtx.defineRoute({
  method: 'GET',
  path: '/single',
  input: {},
  output: UserSchema,
  handler: () => ({ id: '1', name: 'x' }),
})

type MultiModules = readonly [{ multiRoute: typeof multiRoute }]
type SingleModules = readonly [{ singleRoute: typeof singleRoute }]

type MultiGet = ModulesToHonoSchema<MultiModules>['/u/:id']['$get']
type SingleGet = ModulesToHonoSchema<SingleModules>['/single']['$get']

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export type Adr0011RpcProofs = [
  // The map route splits into a per-status union — narrowable by `status`.
  Expect<Equal<Extract<MultiGet, { status: 200 }>['output'], { id: string; name: string }>>,
  Expect<Equal<Extract<MultiGet, { status: 404 }>['output'], z.infer<typeof ErrorBodySchema>>>,
  Expect<Equal<Extract<MultiGet, { status: 200 }>['outputFormat'], 'json'>>,
  // A single schema is unchanged: exactly one endpoint, status 200 (back-compat).
  Expect<Equal<SingleGet['status'], 200>>,
  Expect<Equal<SingleGet['output'], { id: string; name: string }>>,
]
