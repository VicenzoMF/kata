/**
 * Pure handlers behind the three MCP tools. Kept free of any MCP-specific
 * types so they can be unit-tested directly — `server.ts` is the only place
 * that wraps these in the SDK's tool-call envelope.
 */
import type { DocsIndex, IndexedSection } from './indexer'

export type SearchHit = {
  readonly path: string
  readonly title: string
  readonly heading: string
  readonly snippet: string
  readonly score: number
}

const SNIPPET_RADIUS = 160

const makeSnippet = (content: string, query: string): string => {
  const lower = content.toLowerCase()
  const firstTerm = query
    .toLowerCase()
    .split(/\s+/)
    .find((term) => term.length > 0 && lower.includes(term))
  const at = firstTerm ? lower.indexOf(firstTerm) : 0
  const start = Math.max(0, at - SNIPPET_RADIUS / 2)
  const end = Math.min(content.length, start + SNIPPET_RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  return `${prefix}${content.slice(start, end).trim()}${suffix}`
}

export const searchDocs = (
  index: DocsIndex,
  query: string,
  options?: { readonly section?: IndexedSection; readonly limit?: number },
): SearchHit[] => {
  const limit = options?.limit ?? 5
  const results = index.search.search(query)
  const filtered = options?.section
    ? results.filter((r) => (r.path as string).startsWith(`${options.section}/`))
    : results

  return filtered.slice(0, limit).map((result) => {
    const section = index.sections.get(result.id as string)
    const content = section?.content ?? ''
    return {
      path: result.path as string,
      title: result.title as string,
      heading: result.heading as string,
      snippet: makeSnippet(content, query),
      score: result.score as number,
    }
  })
}

export type TocDoc = {
  readonly path: string
  readonly title: string
  readonly description: string
  readonly headings: readonly string[]
}

export type TocEntry = {
  readonly section: string
  readonly docs: readonly TocDoc[]
}

export const getToc = (index: DocsIndex): TocEntry[] => {
  const bySection = new Map<string, TocDoc[]>()

  for (const file of index.files.values()) {
    const section = file.path.split('/')[0] ?? ''
    const docs = bySection.get(section) ?? []
    docs.push({
      path: file.path,
      title: file.title,
      description: file.description,
      headings: file.sections.map((s) => s.heading),
    })
    bySection.set(section, docs)
  }

  return [...bySection.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([section, docs]) => ({
      section,
      docs: docs.sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

export const readDoc = (index: DocsIndex, path: string, heading?: string): string | undefined => {
  const file = index.files.get(path)
  if (!file) return undefined
  if (!heading) return file.body

  const normalized = heading.trim().toLowerCase()
  const section = file.sections.find(
    (s) =>
      s.heading.toLowerCase() === normalized || s.headingPath.toLowerCase().endsWith(normalized),
  )
  return section?.content
}
