import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { noClass } from './no-class'

function fileProject(text: string, relPath: string): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

const MODULE = 'src/modules/users/users.service.ts'

describe('kata/no-class', () => {
  it('flags a class declaration in a module file with an error', () => {
    const issues = noClass.check(fileProject('class Foo {}', MODULE))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/no-class')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.message).toContain('class Foo')
    expect(issues[0]?.why).toContain('ADR-0002')
  })

  it('flags a class expression', () => {
    const issues = noClass.check(fileProject('const Foo = class {}', MODULE))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('(anonymous)')
  })

  it('respects the escape-hatch comment on a class declaration', () => {
    const text = '// kata-allow: class-required-by-vendor\nclass Entity {}'
    expect(noClass.check(fileProject(text, MODULE))).toEqual([])
  })

  it('respects the escape-hatch comment above a class expression', () => {
    const text = '// kata-allow: class-required-by-vendor\nexport const Entity = class {}'
    expect(noClass.check(fileProject(text, MODULE))).toEqual([])
  })

  it('does not let an unrelated comment open the escape hatch', () => {
    const text = '// just a class\nclass Foo {}'
    expect(noClass.check(fileProject(text, MODULE))).toHaveLength(1)
  })

  it('flags each independent class', () => {
    const text = 'class A {}\nclass B {}'
    expect(noClass.check(fileProject(text, MODULE))).toHaveLength(2)
  })

  it('reports the line of the offending class', () => {
    expect(noClass.check(fileProject('\n\nclass Foo {}', MODULE))[0]?.line).toBe(3)
  })

  it('ignores classes outside src/', () => {
    expect(noClass.check(fileProject('class Foo {}', 'scripts/seed.ts'))).toEqual([])
  })

  it('ignores vendored declaration files', () => {
    expect(noClass.check(fileProject('class Foo {}', 'src/types/vendor.d.ts'))).toEqual([])
  })

  it('passes a functional module with no classes', () => {
    const text = 'export function createUserService() {\n  return { findAll: () => [] }\n}'
    expect(noClass.check(fileProject(text, MODULE))).toEqual([])
  })
})
