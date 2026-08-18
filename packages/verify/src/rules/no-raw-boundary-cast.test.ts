import { describe, expect, it } from 'vitest'
import { createProject } from '../project'
import { noRawBoundaryCast } from './no-raw-boundary-cast'

describe('noRawBoundaryCast', () => {
  it('detects as never', () => {
    const issues = noRawBoundaryCast.check(
      createProject({
        root: '/src',
        registryKeys: new Set(),
        files: [
          {
            path: '/src/context.ts',
            relPath: 'src/context.ts',
            text: `const a = 1 as never`,
          },
        ],
      }),
    )
    expect(issues).toHaveLength(1)
  })

  it('detects as unknown as string', () => {
    const issues = noRawBoundaryCast.check(
      createProject({
        root: '/src',
        registryKeys: new Set(),
        files: [
          {
            path: '/src/context.ts',
            relPath: 'src/context.ts',
            text: `const a = 1 as unknown as string`,
          },
        ],
      }),
    )
    expect(issues).toHaveLength(1)
  })

  it('allows with comment', () => {
    const issues = noRawBoundaryCast.check(
      createProject({
        root: '/src',
        registryKeys: new Set(),
        files: [
          {
            path: '/src/context.ts',
            relPath: 'src/context.ts',
            text: `
          // kata-allow: hono-boundary
          const a = 1 as never
          `,
          },
        ],
      }),
    )
    expect(issues).toHaveLength(0)
  })
})
