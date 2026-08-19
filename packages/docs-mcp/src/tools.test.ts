import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildIndex, type DocsIndex } from './indexer'
import { getToc, readDoc, searchDocs } from './tools'

let docsRoot: string
let index: DocsIndex

beforeAll(() => {
  docsRoot = mkdtempSync(join(tmpdir(), 'kata-docs-mcp-'))
  mkdirSync(join(docsRoot, 'guide'), { recursive: true })
  mkdirSync(join(docsRoot, 'reference'), { recursive: true })

  writeFileSync(
    join(docsRoot, 'guide', 'context-di.md'),
    [
      '---',
      'title: Context & DI',
      'description: The single dependency registry.',
      '---',
      '',
      '# Context & DI',
      '',
      'defineContext registers singletons and scoped slots.',
      '',
      '## Scoped slots',
      '',
      'A scoped slot is request-isolated state.',
    ].join('\n'),
  )

  writeFileSync(
    join(docsRoot, 'reference', 'define-route.md'),
    [
      '---',
      'title: defineRoute',
      'description: Declares a route with input/output schemas.',
      '---',
      '',
      '# defineRoute',
      '',
      'Every route declares input and output schemas.',
    ].join('\n'),
  )
})

afterAll(() => {
  rmSync(docsRoot, { recursive: true, force: true })
})

describe('searchDocs', () => {
  it('finds a doc by an exact term in its content', () => {
    const hits = searchDocs(buildIndex(docsRoot), 'scoped slot')
    expect(hits.some((h) => h.path === 'guide/context-di.md')).toBe(true)
  })

  it('restricts results to the given section', () => {
    index = buildIndex(docsRoot)
    const hits = searchDocs(index, 'defineRoute', { section: 'guide' })
    expect(hits).toHaveLength(0)
  })

  it('respects the limit', () => {
    const hits = searchDocs(index, 'schema', { limit: 1 })
    expect(hits.length).toBeLessThanOrEqual(1)
  })
})

describe('getToc', () => {
  it('groups docs by their top-level section', () => {
    const toc = getToc(index)
    const guide = toc.find((t) => t.section === 'guide')
    expect(guide?.docs.map((d) => d.path)).toEqual(['guide/context-di.md'])
    expect(guide?.docs[0]?.headings).toEqual(['Context & DI', 'Scoped slots'])
  })
})

describe('readDoc', () => {
  it('returns the full file body when no heading is given', () => {
    const body = readDoc(index, 'reference/define-route.md')
    expect(body).toContain('Every route declares input and output schemas.')
  })

  it('returns only the matching heading section', () => {
    const section = readDoc(index, 'guide/context-di.md', 'Scoped slots')
    expect(section).toBe('A scoped slot is request-isolated state.')
  })

  it('returns undefined for an unknown path', () => {
    expect(readDoc(index, 'guide/does-not-exist.md')).toBeUndefined()
  })
})
