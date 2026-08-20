import { describe, expect, it } from 'vitest'

import { createProject } from '../project'
import { schemaFileNaming } from './schema-file-naming'

describe('rule: kata/schema-file-naming', () => {
  it('allows valid domain filenames', () => {
    const project = createProject({
      root: '/app',
      registryKeys: new Set(),
      files: [
        {
          path: '/app/src/modules/users/users.route.ts',
          relPath: 'src/modules/users/users.route.ts',
          text: '',
        },
        {
          path: '/app/src/modules/users/users.service.ts',
          relPath: 'src/modules/users/users.service.ts',
          text: '',
        },
        {
          path: '/app/src/modules/users/users.schema.ts',
          relPath: 'src/modules/users/users.schema.ts',
          text: '',
        },
      ],
    })

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(0)
  })

  it('rejects invalid schema filenames', () => {
    const project = createProject({
      root: '/app',
      registryKeys: new Set(),
      files: [
        {
          path: '/app/src/modules/users/auth.schema.ts',
          relPath: 'src/modules/users/auth.schema.ts',
          text: '',
        },
      ],
    })

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.file).toBe('src/modules/users/auth.schema.ts')
    expect(issues[0]!.message).toContain('violates the naming convention')
  })

  it('rejects arbitrary util files', () => {
    const project = createProject({
      root: '/app',
      registryKeys: new Set(),
      files: [
        {
          path: '/app/src/modules/orders/utils.ts',
          relPath: 'src/modules/orders/utils.ts',
          text: '',
        },
      ],
    })

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.file).toBe('src/modules/orders/utils.ts')
    expect(issues[0]!.message).toContain(
      'Expected one of: orders.{route,service,schema,test}.ts or orders.hurl',
    )
  })

  it('lists <domain>.test.ts and <domain>.hurl as legal in the violation message', () => {
    const project = createProject({
      root: '/app',
      registryKeys: new Set(),
      files: [
        {
          path: '/app/src/modules/users/helpers.ts',
          relPath: 'src/modules/users/helpers.ts',
          text: '',
        },
      ],
    })

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toBe(
      'File helpers.ts violates the naming convention. Expected one of: users.{route,service,schema,test}.ts or users.hurl',
    )
  })

  it('ignores files outside src/modules', () => {
    const project = createProject({
      root: '/app',
      registryKeys: new Set(),
      files: [
        { path: '/app/src/shared/utils.ts', relPath: 'src/shared/utils.ts', text: '' },
        { path: '/app/src/app.ts', relPath: 'src/app.ts', text: '' },
      ],
    })

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(0)
  })
})
