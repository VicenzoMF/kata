import { describe, expect, it } from 'vitest'

import { parseDoc } from './indexer'

describe('parseDoc', () => {
  it('extracts title and description from frontmatter', () => {
    const raw = [
      '---',
      'title: Context & DI',
      'description: The single dependency registry.',
      '---',
      '',
      '# Context & DI',
      '',
      'Body text.',
    ].join('\n')

    const doc = parseDoc('guide/context-di.md', raw)

    expect(doc.title).toBe('Context & DI')
    expect(doc.description).toBe('The single dependency registry.')
  })

  it('falls back to the path when frontmatter is missing', () => {
    const doc = parseDoc('guide/no-frontmatter.md', '# Just a heading\n\nBody.')
    expect(doc.title).toBe('guide/no-frontmatter.md')
    expect(doc.description).toBe('')
  })

  it('splits body into one section per heading, tracking a breadcrumb path', () => {
    const raw = [
      '---',
      'title: Middleware',
      'description: d',
      '---',
      '',
      '# Middleware',
      '',
      'Intro text.',
      '',
      '## Scoped slots',
      '',
      'Slot text.',
      '',
      '### Filling a slot',
      '',
      'Fill text.',
    ].join('\n')

    const doc = parseDoc('guide/middleware.md', raw)

    expect(doc.sections.map((s) => s.heading)).toEqual([
      'Middleware',
      'Scoped slots',
      'Filling a slot',
    ])
    expect(doc.sections.map((s) => s.headingPath)).toEqual([
      'Middleware',
      'Middleware > Scoped slots',
      'Middleware > Scoped slots > Filling a slot',
    ])
    expect(doc.sections[1]?.content).toBe('Slot text.')
  })

  it('does not treat a heading-shaped line inside a fenced code block as a heading', () => {
    const raw = [
      '---',
      'title: Example',
      'description: d',
      '---',
      '',
      '# Example',
      '',
      '```ts',
      '// # not a heading',
      'const x = 1',
      '```',
      '',
      'After the fence.',
    ].join('\n')

    const doc = parseDoc('guide/example.md', raw)

    expect(doc.sections).toHaveLength(1)
    expect(doc.sections[0]?.heading).toBe('Example')
    expect(doc.sections[0]?.content).toContain('// # not a heading')
    expect(doc.sections[0]?.content).toContain('After the fence.')
  })

  it('closes a sibling section when a heading of the same or higher level starts', () => {
    const raw = [
      '---',
      'title: T',
      'description: d',
      '---',
      '',
      '# T',
      '',
      '## A',
      '',
      'a text',
      '',
      '## B',
      '',
      'b text',
    ].join('\n')

    const doc = parseDoc('guide/t.md', raw)

    expect(doc.sections.map((s) => s.headingPath)).toEqual(['T > A', 'T > B'])
  })
})
