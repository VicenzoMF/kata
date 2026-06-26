import { defineConfig } from 'tsup'

// Why tsup (not bare `tsc`): the source uses extensionless relative imports
// (e.g. `from './context'`) under `moduleResolution: "Bundler"`. `tsc` would
// emit those verbatim, producing `dist/*.js` that Node's ESM loader cannot
// resolve. tsup bundles the internals into a single ESM file and emits matching
// `.d.ts`. `hono` and `zod` are peerDependencies, which tsup externalises
// automatically — they are never bundled.
//
// `src/cli/main.ts` is the `kata` bin (see package.json `bin`). It is a second
// entry so tsup emits `dist/cli/main.js` with its shebang preserved; bundling
// resolves its extensionless imports the same way it does for the library.
//
// `src/node/index.ts` is the Node-only `kata/node` subpath export (ADR-0014):
// a third entry so tsup emits `dist/node/index.js`, kept out of the root entry
// so an edge/Workers build importing `kata` never pulls in `node:process`
// (ADR-0001 runtime neutrality).
//
// `src/jwt/index.ts` is the `kata/jwt` subpath export (ADR-0013): the JWT
// primitives. A tree-shakeable entry so apps that never import `kata/jwt` pay
// nothing for it; it shares the error/type helpers via `splitting` (below).
export default defineConfig({
  entry: ['src/index.ts', 'src/jwt/index.ts', 'src/node/index.ts', 'src/cli/main.ts'],
  format: ['esm'],
  dts: true,
  // No sourcemaps in the published artifact. esbuild emits maps with
  // `sourcesContent` inlined, which would embed the full TypeScript source into
  // the npm tarball (the cli map alone is ~170 KB) — the package ships bundled
  // `.js` + `.d.ts` only. Dev/test run from `src` via tsx/vitest, not from
  // `dist`, so nothing in-repo relies on these maps.
  sourcemap: false,
  clean: true,
  // `splitting: true` so shared error/type helpers (e.g. `formatZodIssues`, used
  // by both the root entry and `kata/jwt`) are hoisted into a shared chunk rather
  // than inlined into every entry (ADR-0013).
  splitting: true,
})
