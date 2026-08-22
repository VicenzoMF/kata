#!/usr/bin/env node
/**
 * Post-build / post-publish smoke check (issue #235). Speaks real MCP
 * protocol to the built server — unlike `indexer.test.ts` / `tools.test.ts`,
 * which exercise the pure search functions against a synthetic fixture tree,
 * this exercises the actual `docs/` snapshot the package ships, catching the
 * exact failure mode that shipped a stale snapshot in the first place:
 *
 *   1. searching "npm install" must surface `@katajs-framework/core`, not a
 *      stale unscoped `katajs` install line.
 *   2. every indexed ADR must have a unique number — a renumbering that
 *      collides ships silently otherwise.
 *
 * Usage:
 *   node scripts/smoke-check.mjs                    # spawns ./dist/main.js
 *   node scripts/smoke-check.mjs --pkg <name@version>  # spawns `npx -y <spec>`,
 *                                                       for checking the
 *                                                       registry after publish
 */
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const pkgArgIndex = process.argv.indexOf('--pkg')
const pkgSpec = pkgArgIndex !== -1 ? process.argv[pkgArgIndex + 1] : undefined

const serverParams = pkgSpec
  ? { command: 'npx', args: ['-y', pkgSpec] }
  : { command: 'node', args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))] }

const fail = (message) => {
  console.error(`smoke-check: FAIL — ${message}`)
  process.exitCode = 1
}

const parseToolJson = (result) => {
  const text = result.content?.[0]?.text
  if (typeof text !== 'string') throw new Error('tool result had no text content')
  return JSON.parse(text)
}

const client = new Client({ name: 'kata-docs-mcp-smoke-check', version: '0.0.0' })
const transport = new StdioClientTransport(serverParams)

try {
  await client.connect(transport)

  const searchResult = await client.callTool({
    name: 'search_docs',
    arguments: { query: 'npm install', limit: 5 },
  })
  const hits = parseToolJson(searchResult)

  if (!Array.isArray(hits) || hits.length === 0) {
    fail('search_docs("npm install") returned no hits')
  } else if (!hits.some((hit) => hit.snippet?.includes('@katajs-framework/core'))) {
    fail(
      'search_docs("npm install") top hits do not mention @katajs-framework/core — ' +
        `got: ${JSON.stringify(hits.map((h) => h.path))}`,
    )
  } else {
    console.log('smoke-check: OK — "npm install" search surfaces @katajs-framework/core')
  }

  const tocResult = await client.callTool({ name: 'get_toc', arguments: {} })
  const toc = parseToolJson(tocResult)
  const adrSection = toc.find((entry) => entry.section === 'adr')
  const adrNumbers = (adrSection?.docs ?? [])
    .map((doc) => doc.path.match(/(\d{4})-/)?.[1])
    .filter((n) => n !== undefined)

  if (adrNumbers.length === 0) {
    fail('get_toc returned no ADRs to check')
  } else {
    const seen = new Set()
    const dupes = new Set()
    for (const n of adrNumbers) {
      if (seen.has(n)) dupes.add(n)
      seen.add(n)
    }
    if (dupes.size > 0) {
      fail(`ADR number collisions in search results: ${[...dupes].join(', ')}`)
    } else {
      console.log(`smoke-check: OK — ${adrNumbers.length} ADRs indexed, no number collisions`)
    }
  }
} finally {
  await client.close()
}

if (process.exitCode) {
  console.error('smoke-check: one or more checks failed')
} else {
  console.log('smoke-check: all checks passed')
}
