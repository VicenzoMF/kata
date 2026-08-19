/**
 * Builds an in-memory search index over `docs/**​/*.md`. Runtime indexing
 * (no persisted index, no rebuild pipeline) is deliberate — see ADR-0022:
 * the corpus is small enough (~19k lines) that a full rebuild on server
 * boot costs milliseconds, so staleness across a `docs/` edit is a
 * non-issue for a locally-restarted process.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import MiniSearch from 'minisearch'

export type DocSection = {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly heading: string
  readonly headingPath: string
  readonly content: string
}

export type DocFile = {
  readonly path: string
  readonly title: string
  readonly description: string
  readonly body: string
  readonly sections: readonly DocSection[]
}

type SearchDoc = {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly heading: string
  readonly content: string
}

export type DocsIndex = {
  readonly files: ReadonlyMap<string, DocFile>
  readonly sections: ReadonlyMap<string, DocSection>
  readonly search: MiniSearch<SearchDoc>
}

const INDEXED_SECTIONS = ['guide', 'cookbook', 'reference', 'adr'] as const

export type IndexedSection = (typeof INDEXED_SECTIONS)[number]

const parseFrontmatter = (
  raw: string,
): { readonly data: Record<string, string>; readonly body: string } => {
  if (!raw.startsWith('---\n')) return { data: {}, body: raw }

  const close = raw.indexOf('\n---', 4)
  if (close === -1) return { data: {}, body: raw }

  const block = raw.slice(4, close)
  const data: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key) data[key] = value
  }

  const body = raw.slice(close + 4).replace(/^\n+/, '')
  return { data, body }
}

const isFenceLine = (line: string): boolean => /^(```|~~~)/.test(line.trim())

const splitSections = (path: string, title: string, body: string): DocSection[] => {
  const sections: DocSection[] = []
  const stack: { readonly level: number; readonly text: string }[] = []
  let heading = title
  let buffer: string[] = []
  let inFence = false

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (content) {
      const headingPath = stack.length > 0 ? stack.map((s) => s.text).join(' > ') : title
      sections.push({
        id: `${path}#${sections.length}`,
        path,
        title,
        heading,
        headingPath,
        content,
      })
    }
    buffer = []
  }

  for (const line of body.split('\n')) {
    if (isFenceLine(line)) inFence = !inFence

    const match = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match?.[1] && match[2]) {
      flush()
      const level = match[1].length
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop()
      stack.push({ level, text: match[2] })
      heading = match[2]
      continue
    }

    buffer.push(line)
  }
  flush()

  return sections
}

export const parseDoc = (path: string, raw: string): DocFile => {
  const { data, body } = parseFrontmatter(raw)
  const title = data.title ?? path
  const description = data.description ?? ''
  return {
    path,
    title,
    description,
    body,
    sections: splitSections(path, title, body),
  }
}

const walkMarkdownFiles = (root: string, dir: string): string[] => {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === '_template.md') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...walkMarkdownFiles(root, full))
    } else if (entry.endsWith('.md')) {
      files.push(relative(root, full).split(sep).join('/'))
    }
  }
  return files
}

export const buildIndex = (docsRoot: string): DocsIndex => {
  const files = new Map<string, DocFile>()
  const sections = new Map<string, DocSection>()
  const searchDocs: SearchDoc[] = []

  for (const section of INDEXED_SECTIONS) {
    const sectionDir = join(docsRoot, section)
    let paths: string[]
    try {
      paths = walkMarkdownFiles(docsRoot, sectionDir)
    } catch {
      continue
    }

    for (const path of paths) {
      const raw = readFileSync(join(docsRoot, path), 'utf8')
      const doc = parseDoc(path, raw)
      files.set(path, doc)
      for (const docSection of doc.sections) {
        sections.set(docSection.id, docSection)
        searchDocs.push({
          id: docSection.id,
          path: docSection.path,
          title: doc.title,
          heading: docSection.heading,
          content: docSection.content,
        })
      }
    }
  }

  const search = new MiniSearch<SearchDoc>({
    fields: ['title', 'heading', 'content'],
    storeFields: ['path', 'title', 'heading'],
    searchOptions: {
      boost: { title: 3, heading: 2 },
      prefix: true,
      fuzzy: 0.2,
    },
  })
  search.addAll(searchDocs)

  return { files, sections, search }
}
