import { describe, expect, it } from 'vitest'
import { createProject } from '../project'
import { noRawBoundaryCast } from './no-raw-boundary-cast'

describe('noRawBoundaryCast', () => {
  it('rejects as never outside hono-bridge.ts, even with the marker', () => {
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
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('only allowed inside hono-bridge.ts')
  })

  it('allows as never inside hono-bridge.ts, with the marker', () => {
    const issues = noRawBoundaryCast.check(
      createProject({
        root: '/src',
        registryKeys: new Set(),
        files: [
          {
            path: '/src/hono-bridge.ts',
            relPath: 'src/hono-bridge.ts',
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

  it('still requires the marker for as never inside hono-bridge.ts', () => {
    const issues = noRawBoundaryCast.check(
      createProject({
        root: '/src',
        registryKeys: new Set(),
        files: [
          {
            path: '/src/hono-bridge.ts',
            relPath: 'src/hono-bridge.ts',
            text: `const a = 1 as never`,
          },
        ],
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('kata-allow: hono-boundary')
  })

  it('detects as unknown as string without a marker, anywhere', () => {
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

  it('allows as unknown as string outside hono-bridge.ts, with the marker', () => {
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
          const a = 1 as unknown as string
          `,
          },
        ],
      }),
    )
    expect(issues).toHaveLength(0)
  })
})
