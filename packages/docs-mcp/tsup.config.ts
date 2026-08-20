import { defineConfig } from 'tsup'

// Same rationale as packages/kata/tsup.config.ts: source uses extensionless
// relative imports under `moduleResolution: "Bundler"`, which bare `tsc`
// would emit verbatim into unresolvable `dist/*.js`. `@modelcontextprotocol/sdk`
// and `zod` are dependencies (not peers) here, so they're bundled too — a
// consumer running `npx @katajs-framework/docs-mcp` shouldn't need to `npm install`
// anything first.
export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
})
