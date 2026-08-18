import { describe, expect, it } from 'vitest'

import { createAstCache, createProject } from './project'
import type { SourceFile } from './types'

const file = (text: string): SourceFile => ({
  path: '/repo/src/a.ts',
  relPath: 'src/a.ts',
  text,
})

describe('createAstCache()', () => {
  it('returns the same tree for the same file content', () => {
    const ast = createAstCache()
    const source = file('export const a = 1')
    expect(ast(source)).toBe(ast(source))
  })

  it('re-parses when the content changes, and keeps the new tree', () => {
    const ast = createAstCache()
    const before = ast(file('export const a = 1'))
    const after = ast(file('export const a = 2'))
    expect(after).not.toBe(before)
    expect(ast(file('export const a = 2'))).toBe(after)
  })

  it('keys by path, so same-named content in two files does not collide', () => {
    const ast = createAstCache()
    const a = ast({ path: '/repo/a.ts', relPath: 'a.ts', text: 'const x = 1' })
    const b = ast({ path: '/repo/b.ts', relPath: 'b.ts', text: 'const x = 1' })
    expect(a).not.toBe(b)
    expect(a.fileName).toBe('/repo/a.ts')
    expect(b.fileName).toBe('/repo/b.ts')
  })
})

describe('createProject()', () => {
  it('attaches a working AST cache by default', () => {
    const source = file('export const a = 1')
    const project = createProject({
      root: '/repo',
      files: [source],
      registryKeys: null,
      scopedKeys: null,
    })
    expect(project.ast(source)).toBe(project.ast(source))
  })

  it('shares a supplied cache across projects, as watch mode does', () => {
    const ast = createAstCache()
    const source = file('export const a = 1')
    const fields = { root: '/repo', files: [source], registryKeys: null, scopedKeys: null }
    expect(createProject(fields, ast).ast(source)).toBe(createProject(fields, ast).ast(source))
  })

  it('defaults to "no package ships a manifest"', () => {
    const project = createProject({
      root: '/repo',
      files: [],
      registryKeys: null,
      scopedKeys: null,
    })
    expect(project.packageManifest('katajs')).toBeNull()
  })
})
