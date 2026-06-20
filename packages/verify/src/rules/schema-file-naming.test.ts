import { describe, expect, it } from 'vitest'

import type { Project } from '../types'
import { schemaFileNaming } from './schema-file-naming'

describe('rule: kata/schema-file-naming', () => {
  it('allows valid domain filenames', () => {
    const project: Project = {
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
    }

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(0)
  })

  it('rejects invalid schema filenames', () => {
    const project: Project = {
      root: '/app',
      registryKeys: new Set(),
      files: [
        {
          path: '/app/src/modules/users/auth.schema.ts',
          relPath: 'src/modules/users/auth.schema.ts',
          text: '',
        },
      ],
    }

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.file).toBe('src/modules/users/auth.schema.ts')
    expect(issues[0]!.message).toContain('violates the naming convention')
  })

  it('rejects arbitrary util files', () => {
    const project: Project = {
      root: '/app',
      registryKeys: new Set(),
      files: [
        {
          path: '/app/src/modules/orders/utils.ts',
          relPath: 'src/modules/orders/utils.ts',
          text: '',
        },
      ],
    }

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.file).toBe('src/modules/orders/utils.ts')
    expect(issues[0]!.message).toContain('Expected one of: orders.{route,service,schema}.ts')
  })

  it('ignores files outside src/modules', () => {
    const project: Project = {
      root: '/app',
      registryKeys: new Set(),
      files: [
        { path: '/app/src/shared/utils.ts', relPath: 'src/shared/utils.ts', text: '' },
        { path: '/app/src/app.ts', relPath: 'src/app.ts', text: '' },
      ],
    }

    const issues = schemaFileNaming.check(project)
    expect(issues).toHaveLength(0)
  })
})
