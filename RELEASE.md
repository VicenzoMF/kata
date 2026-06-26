# Releasing `katajs` to npm

This document covers how the framework is published. The npm package is
**`katajs`**; the framework's identity stays **Kata** and the CLI command stays
**`kata`** (with a `katajs` bin alias). Only `katajs` is publishable —
`@kata/verify` is `private` and is **bundled into the CLI at build time** (it is
never a runtime dependency and is never published).

The package is *prepared and proven* but **not yet published**: publishing is a
manual action by the owner (needs an npm token).

---

## Name

The bare `kata` on npm is an **unrelated, dormant** package (`kata@1.0.3`,
AGPL-3.0, *"Generate HTML from template literal"*, last published 2022) — we
leave it untouched and publish under **`katajs`** instead. Rationale:

- `katajs` is free, unscoped, and `npx katajs init|verify` works out of the box.
- The framework is still called **Kata**; only the npm id and the import
  specifier are `katajs` (`import … from 'katajs'`).
- The CLI keeps the short `kata` command (`kata init` / `kata new` /
  `kata verify`); a `katajs` bin alias is also published so `npx katajs …`
  resolves to this package and never collides with the squatted `kata`.

A scoped `@<scope>/kata` was the alternative (preserves the literal name like
NestJS/Angular) but was rejected in favour of the simpler unscoped install.

---

## What is prepared in `packages/kata/package.json`

- **Metadata:** `description`, `keywords`, `homepage`, `repository` (with
  `directory: packages/kata`), `bugs`, `license`, `author`, `engines.node >=20`.
- **Entry points:** `main`, `types`, and an `exports` map for `.`, `./jwt`,
  `./node`, and `./package.json`. ESM-only (`"type": "module"`).
- **Bin:** `kata` **and** `katajs`, both → `./dist/cli/main.js` (shebang
  preserved by tsup).
- **`files`:** `["dist", "README.md", "LICENSE", "NOTICE"]` — a whitelist, so
  `src/`, tests, configs, and hooks can never leak (proven below).
- **`sideEffects: false`** for consumer tree-shaking.
- **`publishConfig.access: "public"`.**
- **`peerDependencies`:** `hono ^4`, `zod ^3`, `typescript ^5` (optional —
  only the `kata verify` CLI needs it).
- **`prepublishOnly`:** `pnpm run build && pnpm run typecheck` — the publish
  is aborted if either fails.

Sourcemaps are intentionally **off** in `tsup.config.ts`: esbuild inlines
`sourcesContent`, which would embed the full TypeScript source into the tarball
(the CLI map alone was ~170 KB). The package ships bundled `.js` + `.d.ts` only.

---

## Proof (no real publish performed)

`pnpm --filter=katajs build && cd packages/kata && npm pack --dry-run` →
**14 files, ~40 kB packed / ~142 kB unpacked**:

```
LICENSE  NOTICE  README.md  package.json
dist/index.js          dist/index.d.ts
dist/jwt/index.js      dist/jwt/index.d.ts
dist/node/index.js     dist/node/index.d.ts
dist/cli/main.js       dist/cli/main.d.ts
dist/chunk-*.js        dist/context-*.d.ts        (shared chunks)
```

No `src/`, no `*.test.ts`, no hooks, no `tsconfig`/`tsup`/`biome`/`oxlint`
configs, no `.map` files.

Consumed from a real tarball in a throwaway app (`npm i ./katajs-0.1.0.tgz hono
zod@^3`):

- `import { defineContext } from 'katajs'` → app boots, `GET /hello → 200`.
- `katajs/jwt` and `katajs/node` subpaths resolve at runtime **and** under `tsc
  --strict` with `skipLibCheck: false`.
- `npx katajs --help` / `kata verify` run from the linked bin(s).

---

## Manual release flow

```sh
# 0. Bump version if needed.
pnpm install
pnpm typecheck && pnpm test && pnpm exec kata verify packages/kata

# 1. Build + inspect the tarball
pnpm --filter=katajs build
cd packages/kata
npm pack --dry-run            # confirm contents; expect 0 warnings

# 2. Publish (prepublishOnly re-runs build + typecheck)
npm publish --access public
#    Safer first cut: publish under a pre-release tag, promote later:
#    npm publish --tag next --access public
#    npm dist-tag add katajs@0.1.0 latest

# 3. Tag the release in git
git tag katajs-v0.1.0 && git push origin katajs-v0.1.0

# 4. Verify from the registry in a fresh dir
cd "$(mktemp -d)" && npm init -y >/dev/null
npm i katajs hono zod
node -e "import('katajs').then(m => console.log(Object.keys(m)))"
```

---

## CI release flow (recommended, optional)

Publish on a `katajs-v*` tag so a release is never a laptop-only action. This is
**not** wired yet — adding a workflow is an owner action (the harness blocks
agent edits to `.github/workflows/`, and CI config is an L3 guardrail). Add the
`NPM_TOKEN` repo secret (an npm **automation** token), then create
`.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ['katajs-v*']
permissions:
  contents: read
  id-token: write          # required for npm provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck && pnpm test && pnpm exec kata verify packages/kata
      - run: pnpm --filter=katajs build
      - run: npm publish --access public --provenance
        working-directory: packages/kata
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`--provenance` needs `id-token: write`, npm ≥ 9.5, and a public repo; drop it
otherwise. For multi-package releases later, consider Changesets — overkill
while `katajs` is the only published package.
