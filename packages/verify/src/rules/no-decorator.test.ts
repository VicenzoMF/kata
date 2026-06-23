import { describe, expect, it } from 'vitest'

import type { Project, SourceFile } from '../types'

import { noDecorator } from './no-decorator'

function fileProject(text: string, relPath = 'src/modules/users/users.route.ts'): Project {
  const file: SourceFile = { path: `/repo/${relPath}`, relPath, text }
  return { root: '/repo', files: [file], registryKeys: null }
}

describe('kata/no-decorator', () => {
  it('flags a class decorator', () => {
    const issues = noDecorator.check(fileProject('@Controller()\nexport class C {}'))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('kata/no-decorator')
    expect(issues[0]?.severity).toBe('error')
    expect(issues[0]?.why).toContain('ADR-0002')
  })

  it('flags a method decorator', () => {
    const issues = noDecorator.check(fileProject('export class C {\n  @Get()\n  find() {}\n}'))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.line).toBe(2)
  })

  it('flags a parameter decorator', () => {
    const issues = noDecorator.check(
      fileProject('export class C {\n  find(@Param() id: string) {}\n}'),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.line).toBe(2)
  })

  it('flags every decorator independently', () => {
    const issues = noDecorator.check(
      fileProject('@Controller()\nexport class C {\n  @Get()\n  find(@Param() id: string) {}\n}'),
    )
    expect(issues).toHaveLength(3)
  })

  it('reports the position of the @ token', () => {
    const issues = noDecorator.check(fileProject('\n\n@Controller()\nexport class C {}'))
    expect(issues[0]?.line).toBe(3)
    expect(issues[0]?.column).toBe(1)
  })

  it('honors the // kata-allow: escape hatch on the decorated declaration', () => {
    const issues = noDecorator.check(
      fileProject('// kata-allow: decorator-required-by-vendor\n@Entity()\nexport class User {}'),
    )
    expect(issues).toEqual([])
  })

  it('does not let an allow-comment on one class leak to an undecorated sibling', () => {
    const issues = noDecorator.check(
      fileProject(
        '// kata-allow: decorator-required-by-vendor\n@Entity()\nexport class A {}\n\n@Controller()\nexport class B {}',
      ),
    )
    expect(issues).toHaveLength(1)
  })

  it('ignores files outside src/', () => {
    const issues = noDecorator.check(
      fileProject('@Controller()\nexport class C {}', 'scripts/x.ts'),
    )
    expect(issues).toEqual([])
  })

  it('passes decorator-free functional code', () => {
    const issues = noDecorator.check(
      fileProject(
        "export const r = defineRoute({ method: 'GET', path: '/', handler: () => null })",
      ),
    )
    expect(issues).toEqual([])
  })
})
