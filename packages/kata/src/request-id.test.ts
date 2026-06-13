import { describe, expect, it } from 'vitest'

import { REQUEST_ID_HEADER, resolveRequestId } from './request-id'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('REQUEST_ID_HEADER', () => {
  it('is the lower-case x-request-id header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id')
  })
})

describe('resolveRequestId()', () => {
  it('generates a UUID when there is no inbound id', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID)
  })

  it('generates a fresh id each call', () => {
    expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined))
  })

  it('reuses a well-formed inbound id (UUID)', () => {
    const inbound = '11111111-2222-3333-4444-555555555555'
    expect(resolveRequestId(inbound)).toBe(inbound)
  })

  it('reuses a W3C-style trace id with : and -', () => {
    const inbound = '00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01'
    expect(resolveRequestId(inbound)).toBe(inbound)
  })

  it('trims surrounding whitespace from an inbound id', () => {
    expect(resolveRequestId('  abc-123  ')).toBe('abc-123')
  })

  it('ignores an empty or whitespace-only inbound id', () => {
    expect(resolveRequestId('')).toMatch(UUID)
    expect(resolveRequestId('   ')).toMatch(UUID)
  })

  it('ignores an inbound id with unsafe characters (log/header injection)', () => {
    expect(resolveRequestId('id with spaces')).toMatch(UUID)
    expect(resolveRequestId('inject\nNEWLINE')).toMatch(UUID)
    expect(resolveRequestId('a/b?c#d')).toMatch(UUID)
  })

  it('ignores an over-long inbound id', () => {
    expect(resolveRequestId('a'.repeat(201))).toMatch(UUID)
    expect(resolveRequestId('a'.repeat(200))).toBe('a'.repeat(200))
  })
})
