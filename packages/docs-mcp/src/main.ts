#!/usr/bin/env tsx
/**
 * Executable entry for the `kata-docs-mcp` bin. Resolves `docs/` relative to
 * this package's location in the monorepo, not the caller's cwd, so the
 * server works regardless of where it's launched from.
 */
import { fileURLToPath } from 'node:url'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { buildIndex } from './indexer'
import { createServer } from './server'

const docsRoot = fileURLToPath(new URL('../../../docs', import.meta.url))

const index = buildIndex(docsRoot)
const server = createServer(index)
const transport = new StdioServerTransport()
await server.connect(transport)
