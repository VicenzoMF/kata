# Releasing `kata` to npm

This document covers how the **`kata`** package (`packages/kata`) is published.
Only `kata` is publishable — `@kata/verify` is `private` and is **bundled into
the CLI at build time** (it is never a runtime dependency and is never
published).

The package is *prepared and proven* but **not yet published**: publishing is a
manual action by the owner (needs an npm token and the name decision below).

---

## ⚠️ Blocker: the npm name `kata` is taken

`npm view kata` (checked 2026-06-26):

```
kata@1.0.3 | AGPL-3.0-only | deps: none
"Generate HTML from template literal"  — by smcmurray, last publish > 1 year ago
```

This is an **unrelated** package. We cannot publish over it; `npm publish` would
return `403 Forbidden`. The owner must pick a name **before the first publish**.
`packages/kata/package.json` still carries `"name": "kata"` (the in-repo brand /
workspace name) on purpose — it is left for the owner to change as part of the
chosen option, not decided here.

### Options (owner's call)

| # | Option | Install / import | Pros | Cons |
|---|--------|------------------|------|------|
| **A** | **Scope under your npm account/org** — `@<scope>/kata` (e.g. `@vicenzomf/kata`) | `npm i @scope/kata` → `import … from '@scope/kata'` | Your username scope is guaranteed available; keeps the `kata` name; publishable today. `publishConfig.access: "public"` is already set. | Scoped import is longer. `npx kata …` resolves to the *taken* `kata`, not ours (the local `kata` **bin** still works after install). |
| **B** | **Rename, unscoped** — `katajs` / `kata-framework` / `kata-web` / `kata-hono` / `hono-kata` (all verified **free** on 2026-06-26; `katana` is taken) | `npm i katajs` → `import … from 'katajs'` | Clean unscoped import; `npx <name> verify` works out of the box. | Not the bare `kata`; reserve the chosen name early to avoid a future squat. |
| **C** | **Acquire / negotiate `kata`** — contact `smcmurray` or file an npm name dispute | unchanged | Ideal name. | Low probability (generic word, published package); slow; not actionable now. |

**Recommendation (non-binding):** ship **A — `@<scope>/kata`** to keep the brand
and publish immediately; or **B — `katajs`** if `npx kata`-style ergonomics
matter more than the scope. Either way the **bin command stays `kata`**
(`kata init` / `kata new` / `kata verify`), since the bin name is independent of
the package name.

### Applying the chosen name (A or B)

1. `packages/kata/package.json` → `"name"` (and keep `publishConfig.access:
   "public"` — required for a scoped public package, harmless otherwise).
2. Update the in-repo references to the import specifier:
   - root `package.json` → `devDependencies.kata`
   - `examples/*/package.json` → `dependencies.kata`
   - example/docs source imports: `from 'kata'`, `'kata/jwt'`, `'kata/node'`
   - `packages/kata/README.md` install snippet (`pnpm add kata hono zod`)
3. `pnpm install` to refresh the lockfile, then re-run the checks below.

---

## What is already prepared

`packages/kata/package.json` ships with:

- **Metadata:** `description`, `keywords`, `homepage`, `repository` (with
  `directory: packages/kata`), `bugs`, `license`, `author`, `engines.node >=20`.
- **Entry points:** `main`, `types`, and an `exports` map for `.`, `./jwt`,
  `./node`, and `./package.json`. ESM-only (`"type": "module"`).
- **Bin:** `kata` → `./dist/cli/main.js` (shebang preserved by tsup).
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

`pnpm --filter=kata build && cd packages/kata && npm pack --dry-run` →
**14 files, 40.0 kB packed / 142.4 kB unpacked**:

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

Consumed from a real tarball in a throwaway app (`npm i ./kata-0.1.0.tgz hono
zod@^3`):

- `import { defineContext } from 'kata'` → app boots, `GET /hello → 200`.
- `kata/jwt` and `kata/node` subpaths resolve at runtime **and** under `tsc
  --strict` with `skipLibCheck: false`.
- `npx kata --help` / `kata verify` run from the linked bin.

---

## Manual release flow

```sh
# 0. Decide & set the name (see Blocker above). Bump version if needed.
pnpm install
pnpm typecheck && pnpm test && pnpm exec kata verify packages/kata

# 1. Build + inspect the tarball
pnpm --filter=kata build
cd packages/kata
npm pack --dry-run            # confirm contents; expect 0 warnings

# 2. Publish (prepublishOnly re-runs build + typecheck)
#    --access public is implied by publishConfig; pass it explicitly if scoped.
npm publish --access public
#    Safer first cut: publish under a pre-release tag, promote later:
#    npm publish --tag next --access public
#    npm dist-tag add <name>@0.1.0 latest

# 3. Tag the release in git
git tag kata-v0.1.0 && git push origin kata-v0.1.0

# 4. Verify from the registry in a fresh dir
cd "$(mktemp -d)" && npm init -y >/dev/null
npm i <name> hono zod
node -e "import('<name>').then(m => console.log(Object.keys(m)))"
```

---

## CI release flow (recommended, optional)

Publish on a `kata-v*` tag so a release is never a laptop-only action. This is
**not** wired yet — adding a workflow is an owner action (the harness blocks
agent edits to `.github/workflows/`, and CI config is an L3 guardrail). Add the
`NPM_TOKEN` repo secret (an npm **automation** token), then create
`.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ['kata-v*']
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
      - run: pnpm --filter=kata build
      - run: npm publish --access public --provenance
        working-directory: packages/kata
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`--provenance` needs `id-token: write`, npm ≥ 9.5, and a public repo; drop it
otherwise. For multi-package releases later, consider Changesets — overkill
while `kata` is the only published package.
