import { defineConfig } from 'tsup'

// Why tsup (not bare `tsc`): the source uses extensionless relative imports
// (e.g. `from './context'`) under `moduleResolution: "Bundler"`. `tsc` would
// emit those verbatim, producing `dist/*.js` that Node's ESM loader cannot
// resolve. tsup bundles the internals into a single ESM file and emits matching
// `.d.ts`. `hono` and `zod` are peerDependencies, which tsup externalises
// automatically — they are never bundled.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
