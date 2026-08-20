// `.mcp.json` written by `kata init --with-docs-mcp` (ADR-0023). Points at
// the published `@katajs/docs-mcp` package via `npx` so the generated app
// carries no extra install step — `npx` fetches and caches it on first run.
import type { McpConfig } from './types'

export const mcpJsonTemplate: McpConfig = {
  mcpServers: {
    'kata-docs': {
      command: 'npx',
      args: ['-y', '@katajs/docs-mcp'],
    },
  },
}
