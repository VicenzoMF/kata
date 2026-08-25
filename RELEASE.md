# Releasing `@katajs-framework/core` to npm

This document covers how the framework is published. The npm package is
**`@katajs-framework/core`**; the framework's identity stays **Kata** and the CLI command stays
**`kata`** (with a `@katajs-framework/core` bin alias). Only `@katajs-framework/core` is publishable —
`@katajs-framework/verify` is `private` and is **bundled into the CLI at build time** (it is
never a runtime dependency and is never published).

**Published.** `@katajs-framework/core@0.3.0` went out on 2026-08-20; `0.3.1`
follows with the `kata init` fix (0.3.0 shipped a CLI bundle that imported
`typescript` eagerly, so the documented bootstrap crashed — deprecate it).
Publishing is a manual action by the owner. The npm account has 2FA set to `auth-and-writes`
via **passkey**, not TOTP — `--otp=<code>` does not apply. `npm publish` prints
an auth URL to approve in the browser, so it needs a real TTY; a non-interactive
shell fails with `EOTP` before ever reaching the registry.

---

## Name

The package is **`@katajs-framework/core`**, under the **`@katajs-framework`**
org. The framework's identity stays **Kata** and the CLI command stays
**`kata`**. Every shorter name was tried against the live registry and failed:

1. **`kata`** — taken. An unrelated, dormant package (`kata@1.0.3`, AGPL-3.0,
   *"Generate HTML from template literal"*, last published 2022). Left untouched.
2. **`katajs`** — unregistered but unpublishable. `npm publish` fails with
   `E403 Package name too similar to existing package kata-js`. `kata-js` is a
   dead 2016 boilerplate (one version, never updated, maintainer `ivoputzer`);
   npm normalises punctuation, so `kata-js` and `katajs` collide.
3. **`@kata`** — taken. The scope belongs to another npm account, so
   `@kata/docs-mcp` (ADR-0023) was never publishable either.
4. **`@katajs`** — unavailable as an org name.
5. **`kata-framework`** and every other unscoped `kata-*` — the registry shows
   them free (404), but the publish is still rejected. The similarity filter is
   **not** limited to punctuation normalisation: it matches against the bare
   `kata` too. Treat every unscoped name beginning with `kata` as blocked; a
   404 on the registry is *not* evidence that a name can be published.

Scoped packages are exempt from the similarity filter, which is why a scope is
the only viable shape. `@katajs-framework/core` is the NestJS/Angular form
(`@nestjs/core`, `@angular/core`) and gives `@katajs-framework/docs-mcp` and
`@katajs-framework/verify` a home under one owned scope.

Consequences:

- Import specifier is `@katajs-framework/core` (`import … from '@katajs-framework/core'`), with
  `@katajs-framework/core/jwt` and `@katajs-framework/core/node` subpaths.
- The CLI keeps the short `kata` command (`kata init` / `kata new` /
  `kata verify`), plus a `katajs` bin alias. Both resolve inside a project that
  depends on the package; neither can bootstrap from an empty directory, since
  no unscoped `kata`/`katajs` package of ours exists. Bootstrap is
  `npx @katajs-framework/core init`.
- **Every `bin` entry must point at the same file.** There is no bin named
  `core`, so npm's "bin matching the unscoped package name" rule never fires.
  The bootstrap resolves only because npm falls back to
  `new Set(Object.values(bin)).size === 1` (libnpmexec's
  `get-bin-from-manifest.js`) — several names are fine while they alias one
  file. Give `kata` and `katajs` different targets and
  `npx @katajs-framework/core …` dies with "could not determine executable to
  run", while every already-installed project keeps working. Locked by a test
  in `cli.test.ts`.
- The scaffold pins `@katajs-framework/core` to the CLI's own version (`KATA_VERSION`), so
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
- **Bin:** `kata` **and** `@katajs-framework/core`, both → `./dist/cli/main.js` (shebang
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

## Proof (pre-publish tarball checks)

`pnpm --filter=@katajs-framework/core build && cd packages/kata && npm pack --dry-run` →
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

- `import { defineContext } from '@katajs-framework/core'` → app boots, `GET /hello → 200`.
- `@katajs-framework/core/jwt` and `@katajs-framework/core/node` subpaths resolve at runtime **and** under `tsc
  --strict` with `skipLibCheck: false`.
- `npx @katajs-framework/core --help` / `kata verify` run from the linked bin(s).

---

## Manual release flow

```sh
# 0. Bump version if needed.
pnpm install
pnpm typecheck && pnpm test && pnpm exec kata verify packages/kata

# 1. Build + inspect the tarball
pnpm --filter=@katajs-framework/core build
cd packages/kata
npm pack --dry-run            # confirm contents; expect 0 warnings

# 2. Publish (prepublishOnly re-runs build + typecheck)
npm publish --access public
#    Safer first cut: publish under a pre-release tag, promote later:
#    npm publish --tag next --access public
#    npm dist-tag add @katajs-framework/core@0.3.1 latest

# 3. Tag the release in git
git tag katajs-v0.3.1 && git push origin katajs-v0.3.1

# 4. Verify from the registry in a fresh dir
cd "$(mktemp -d)" && npm init -y >/dev/null
npm i @katajs-framework/core hono zod
node -e "import('@katajs-framework/core').then(m => console.log(Object.keys(m)))"
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
      - run: pnpm --filter=@katajs-framework/core build
      - run: npm publish --access public --provenance
        working-directory: packages/kata
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

> **Deprecated auth path.** The `NPM_TOKEN` flow above is on borrowed time:
> npm granular tokens configured to bypass 2FA lose the right to publish after
> **January 2027**. Once `@katajs-framework/core` exists on the registry, replace it with
> **trusted publishing (OIDC)** — no stored token at all. It could not be used
> for the first release: a trusted publisher is configured in the package's
> settings on npmjs.com, which requires the package to already exist.

`--provenance` needs `id-token: write`, npm ≥ 9.5, and a public repo; drop it
otherwise. For multi-package releases later, consider Changesets — overkill
while `@katajs-framework/core` is the only published package.

---

# Releasing `@katajs-framework/docs-mcp` to npm

`packages/docs-mcp/scripts/copy-docs.mjs` bundles `docs/{guide,cookbook,reference,adr}`
into the package at **build** time (ADR-0023) — the published tarball is a
frozen snapshot, not a live read of the monorepo's `docs/`. That means a
docs-mcp release goes stale the moment `docs/` changes underneath it or
`@katajs-framework/core` ships a version the snapshot doesn't describe yet
(issue #235: an MCP consumer saw `npm install katajs` and six ADRs numbered
`0016` months after both were fixed on `main`, because the snapshot was never
rebuilt against current docs).

**Release whenever either is true:**
- `docs/{guide,cookbook,reference,adr}` changed since the last docs-mcp release, **or**
- `@katajs-framework/core` shipped a new version.

There is no automatic trigger for this yet — check it by hand (or eyeball
`git log --oneline <last-docs-mcp-tag>..HEAD -- docs/ packages/kata` before
publishing).

## Manual release flow

```sh
# 0. Bump packages/docs-mcp/package.json version if needed.

# 1. Guard: fail fast if the checkout can't legitimately be published from
#    (dirty working tree, or HEAD doesn't contain the latest katajs-v* tag —
#    issue #280). prepublishOnly also runs this, so step 3 re-checks it.
pnpm --filter=@katajs-framework/docs-mcp run check-publish-ready

# 2. Build (copies docs/ fresh, then bundles) and smoke-check the local build.
pnpm --filter=@katajs-framework/docs-mcp build
pnpm --filter=@katajs-framework/docs-mcp smoke-check

# 3. Publish (same manual, passkey-gated flow as core — see above;
#    prepublishOnly re-runs check-publish-ready + build + typecheck).
cd packages/docs-mcp
npm publish --access public

# 4. Tag the release in git
git tag docs-mcp-v0.1.0 && git push origin docs-mcp-v0.1.0

# 5. Post-publish smoke check against the real registry artifact, not just
#    the local build — confirms `npx -y` resolves and serves the published
#    snapshot.
node scripts/smoke-check.mjs --pkg @katajs-framework/docs-mcp@0.1.0
```

`check-publish-ready.mjs` (issue #280) is what catches the exact failure mode
that shipped `0.1.0`/`0.1.1` stale: it fails if the working tree is dirty, or
if `HEAD` does not contain the latest `katajs-v*` tag — i.e. this checkout's
`docs/` predates the core release it's supposed to document. It is wired into
`prepublishOnly`, so a bare `npm publish` from a stale checkout now fails
before it ever reaches the registry.

`smoke-check.mjs` speaks real MCP protocol to the running server (spawned via
stdio) and asserts two things a stale snapshot breaks silently:
`search_docs("npm install")` surfaces `@katajs-framework/core` (not a stale
unscoped `katajs`), and every indexed ADR has a unique number. Run it after
step 2 against the local build, and again after step 3 against the published
package — a green local check with a red registry check means the publish
itself went wrong (wrong tag, stale `npm pack`, etc.), not the docs.

## CI release flow (recommended, optional)

Publish on a `docs-mcp-v*` tag so a release is never a laptop-only action,
mirroring core's release workflow above. This is **not** wired yet — adding a
workflow is an owner action (the harness blocks agent edits to
`.github/workflows/`, and CI config is an L3 guardrail). Reuse the same
`NPM_TOKEN` repo secret as core (or migrate both to trusted publishing
together — see the deprecation note under core's CI flow above), then create
`.github/workflows/release-docs-mcp.yml`:

```yaml
name: release-docs-mcp
on:
  push:
    tags: ['docs-mcp-v*']
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
      - run: pnpm typecheck && pnpm test
      - run: pnpm --filter=@katajs-framework/docs-mcp run check-publish-ready
      - run: pnpm --filter=@katajs-framework/docs-mcp build
      - run: pnpm --filter=@katajs-framework/docs-mcp smoke-check
      - run: npm publish --access public --provenance
        working-directory: packages/docs-mcp
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - run: |
          VERSION="${GITHUB_REF_NAME#docs-mcp-v}"
          node scripts/smoke-check.mjs --pkg "@katajs-framework/docs-mcp@$VERSION"
        working-directory: packages/docs-mcp
```

`check-publish-ready` running in CI is somewhat belt-and-suspenders (a
tag-triggered checkout is already pinned to one commit), but it stays useful
as the same fast-fail if someone tags `docs-mcp-v*` from a branch that hasn't
picked up the latest `katajs-v*` release yet.
