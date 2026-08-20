# Releasing `@katajs/core` to npm

This document covers how the framework is published. The npm package is
**`@katajs/core`**; the framework's identity stays **Kata** and the CLI command stays
**`kata`** (with a `@katajs/core` bin alias). Only `@katajs/core` is publishable —
`@katajs/verify` is `private` and is **bundled into the CLI at build time** (it is
never a runtime dependency and is never published).

The package is *prepared and proven* but **not yet published**: publishing is a
manual action by the owner. The npm account has 2FA set to `auth-and-writes`
via **passkey**, not TOTP — `--otp=<code>` does not apply. `npm publish` prints
an auth URL to approve in the browser, so it needs a real TTY; a non-interactive
shell fails with `EOTP` before ever reaching the registry.

---

## Name

The package is **`@katajs/core`**. The framework's identity stays **Kata** and the
CLI command stays **`kata`**. Three npm constraints forced the scope:

1. **`kata` is taken** — an unrelated, dormant package (`kata@1.0.3`, AGPL-3.0,
   *"Generate HTML from template literal"*, last published 2022). Left untouched.
2. **`katajs` is unpublishable** — npm's name-similarity filter rejects it with
   `E403 Package name too similar to existing package kata-js`. `kata-js` is a
   dead 2016 boilerplate (one version, never updated, maintainer `ivoputzer`),
   but npm normalises punctuation, so `kata-js` and `katajs` collide. The name
   is free yet permanently blocked while `kata-js` exists.
3. **`@kata` is taken** — the scope belongs to another npm account.

Scoped packages are exempt from the similarity filter, so `@katajs/core` is the
first name that both reads correctly and can actually be published. This is the
NestJS/Angular shape (`@nestjs/core`, `@angular/core`) and leaves room for
`@katajs/docs-mcp` and `@katajs/verify` under one scope.

Consequences:

- Import specifier is `@katajs/core` (`import … from '@katajs/core'`), with
  `@katajs/core/jwt` and `@katajs/core/node` subpaths.
- The CLI keeps the short `kata` command (`kata init` / `kata new` /
  `kata verify`). A `katajs` bin alias still ships, so `npx katajs …` works
  *inside a project that already depends on the package*; it can no longer
  bootstrap from an empty directory, since the unscoped `katajs` does not exist.
  Bootstrap is `npx @katajs/core init`.
- The scaffold pins `@katajs/core` to the CLI's own version (`KATA_VERSION`), so
  a released minor never generates an unresolvable range.

An earlier revision of this document chose the unscoped `katajs` and explicitly
rejected a scope "in favour of the simpler unscoped install". That rationale is
void: the unscoped install was never available.

---

## What is prepared in `packages/kata/package.json`

- **Metadata:** `description`, `keywords`, `homepage`, `repository` (with
  `directory: packages/kata`), `bugs`, `license`, `author`, `engines.node >=20`.
- **Entry points:** `main`, `types`, and an `exports` map for `.`, `./jwt`,
  `./node`, and `./package.json`. ESM-only (`"type": "module"`).
- **Bin:** `kata` **and** `@katajs/core`, both → `./dist/cli/main.js` (shebang
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

`pnpm --filter=@katajs/core build && cd packages/kata && npm pack --dry-run` →
**15 files, ~58 kB packed / ~208 kB unpacked**:

```
LICENSE  NOTICE  README.md  package.json  provides.json
dist/index.js          dist/index.d.ts
dist/jwt/index.js      dist/jwt/index.d.ts
dist/node/index.js     dist/node/index.d.ts
dist/cli/main.js       dist/cli/main.d.ts
dist/chunk-*.js        dist/context-*.d.ts        (shared chunks)
```

No `src/`, no `*.test.ts`, no hooks, no `tsconfig`/`tsup`/`biome`/`oxlint`
configs, no `.map` files.

Consumed from a real tarball in a throwaway app (`npm i ./katajs-core-0.3.0.tgz hono
zod@^3`):

- `import { defineContext } from '@katajs/core'` → app boots, `GET /hello → 200`.
- `@katajs/core/jwt` and `@katajs/core/node` subpaths resolve at runtime **and** under `tsc
  --strict` with `skipLibCheck: false`.
- `npx @katajs/core --help` / `kata verify` run from the linked bin(s).

---

## Manual release flow

```sh
# 0. Bump version if needed.
pnpm install
pnpm typecheck && pnpm test && pnpm exec kata verify packages/kata

# 1. Build + inspect the tarball
pnpm --filter=@katajs/core build
cd packages/kata
npm pack --dry-run            # confirm contents; expect 0 warnings

# 2. Publish (prepublishOnly re-runs build + typecheck)
npm publish --access public
#    Safer first cut: publish under a pre-release tag, promote later:
#    npm publish --tag next --access public
#    npm dist-tag add @katajs/core@0.3.0 latest

# 3. Tag the release in git
git tag katajs-v0.3.0 && git push origin katajs-v0.3.0

# 4. Verify from the registry in a fresh dir
cd "$(mktemp -d)" && npm init -y >/dev/null
npm i @katajs/core hono zod
node -e "import('@katajs/core').then(m => console.log(Object.keys(m)))"
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
      - run: pnpm --filter=@katajs/core build
      - run: npm publish --access public --provenance
        working-directory: packages/kata
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

> **Deprecated auth path.** The `NPM_TOKEN` flow above is on borrowed time:
> npm granular tokens configured to bypass 2FA lose the right to publish after
> **January 2027**. Once `@katajs/core` exists on the registry, replace it with
> **trusted publishing (OIDC)** — no stored token at all. It could not be used
> for the first release: a trusted publisher is configured in the package's
> settings on npmjs.com, which requires the package to already exist.

`--provenance` needs `id-token: write`, npm ≥ 9.5, and a public repo; drop it
otherwise. For multi-package releases later, consider Changesets — overkill
while `@katajs/core` is the only published package.
