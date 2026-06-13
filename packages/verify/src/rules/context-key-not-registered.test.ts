import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { contextKeyNotRegistered } from './context-key-not-registered'

function project(text: string, registryKeys: ReadonlySet<string> | null): Project {
  const file: SourceFile = {
    path: '/repo/src/modules/users/users.route.ts',
    relPath: 'src/modules/users/users.route.ts',
    text,
  }
  return { root: '/repo', files: [file], registryKeys }
}

const registry = new Set(['logger', 'currentUser'])

describe('kata/context-key-not-registered', () => {
  it('passes c.get for a registered key', () => {
    const p = project("const u = c.get('currentUser')", registry)
    expect(contextKeyNotRegistered.check(p)).toEqual([])
  })

  it('flags c.get for an unregistered key', () => {
    const p = project("const u = c.get('currentUserr')", registry)
    const issues = contextKeyNotRegistered.check(p)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/context-key-not-registered')
    expect(issues[0]?.message).toContain("c.get('currentUserr')")
    expect(issues[0]?.why).toContain('ADR-0004')
    // The fix lists the registered keys, sorted, so the agent can correct the typo.
    expect(issues[0]?.fix).toContain('currentUser, logger')
  })

  it('disables itself when the registry is indeterminate', () => {
    const p = project("const u = c.get('whatever')", null)
    expect(contextKeyNotRegistered.check(p)).toEqual([])
  })

  it('ignores .get on a non-context receiver', () => {
    const p = project("const v = cache.get('missing')", registry)
    expect(contextKeyNotRegistered.check(p)).toEqual([])
  })

  it('ignores a dynamic (non-literal) key', () => {
    const p = project('const u = c.get(keyVar)', registry)
    expect(contextKeyNotRegistered.check(p)).toEqual([])
  })

  it('ignores get calls with the wrong arity', () => {
    const p = project("const u = c.get('currentUserr', fallback)", registry)
    expect(contextKeyNotRegistered.check(p)).toEqual([])
  })

  it('reports the line of the offending call', () => {
    const p = project("\n\nconst u = c.get('nope')", registry)
    const issues = contextKeyNotRegistered.check(p)
    expect(issues[0]?.line).toBe(3)
  })
})
