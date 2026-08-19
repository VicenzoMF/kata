/**
 * Wires the three docs tools onto an MCP server. Kept separate from
 * `main.ts` so the server can be built and exercised without a live stdio
 * connection (e.g. in tests, via `server.js` client transports).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { DocsIndex } from './indexer'
import { getToc, readDoc, searchDocs } from './tools'

const SECTIONS = ['guide', 'cookbook', 'reference', 'adr'] as const

export const createServer = (index: DocsIndex): McpServer => {
  const server = new McpServer({ name: 'kata-docs', version: '0.0.0' })

  server.registerTool(
    'search_docs',
    {
      description:
        'Full-text search over the Kata documentation (guide, cookbook, reference, ADRs). ' +
        'Use exact API names, symbols, or concepts as the query.',
      inputSchema: {
        query: z.string().min(1).describe('Search terms — exact API names, symbols, or concepts'),
        section: z
          .enum(SECTIONS)
          .optional()
          .describe('Restrict the search to one section of the docs'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('Maximum number of hits to return'),
      },
    },
    async ({ query, section, limit }) => {
      const hits = searchDocs(index, query, { section, limit })
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] }
    },
  )

  server.registerTool(
    'get_toc',
    {
      description:
        'List every indexed Kata doc grouped by section (guide/cookbook/reference/adr), with ' +
        "each doc's title, description, and heading structure. Use to navigate directly when " +
        'you already know roughly where to look, without a search round-trip.',
      inputSchema: {},
    },
    async () => {
      const toc = getToc(index)
      return { content: [{ type: 'text', text: JSON.stringify(toc, null, 2) }] }
    },
  )

  server.registerTool(
    'read_doc',
    {
      description:
        'Read a Kata doc by path, as returned by search_docs or get_toc (e.g. "guide/context-di.md"). ' +
        'Pass `heading` to get only that section instead of the whole file.',
      inputSchema: {
        path: z.string().min(1).describe('Doc path, e.g. "guide/context-di.md"'),
        heading: z.string().optional().describe("Return only this heading's section"),
      },
    },
    async ({ path, heading }) => {
      const doc = readDoc(index, path, heading)
      if (doc === undefined) {
        return {
          content: [{ type: 'text', text: `Not found: ${path}${heading ? ` § ${heading}` : ''}` }],
          isError: true,
        }
      }
      return { content: [{ type: 'text', text: doc }] }
    },
  )

  return server
}
