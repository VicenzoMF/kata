#!/usr/bin/env node
/**
 * Closes the merge -> publish loop for the Changesets flow (see RELEASE.md):
 * a merged "Version Packages" PR bumps package.json versions but creates no
 * git tag, and release.yml / release-docs-mcp.yml only trigger on a
 * `katajs-v*` / `docs-mcp-v*` tag push. Run on every push to `main`; for each
 * publishable package whose current version has no matching tag yet, create
 * and push one — idempotent, so a push with no version bump is a no-op.
 *
 * Run standalone: `node scripts/tag-release-if-version-bumped.mjs`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PACKAGES = [
  { dir: 'packages/kata', tagPrefix: 'katajs-v' },
  { dir: 'packages/docs-mcp', tagPrefix: 'docs-mcp-v' },
]

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const tagsToPush = []

for (const { dir, tagPrefix } of PACKAGES) {
  const { name, version } = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const tag = `${tagPrefix}${version}`
  const existing = git(['tag', '--list', tag])

  if (existing) {
    console.log(`tag-release: ${name}@${version} already tagged (${tag}) — skipping`)
    continue
  }

  git(['tag', tag])
  tagsToPush.push(tag)
  console.log(`tag-release: created ${tag} for ${name}@${version}`)
}

if (tagsToPush.length === 0) {
  console.log('tag-release: no version bumps to tag')
  process.exit(0)
}

git(['push', 'origin', ...tagsToPush])
console.log(`tag-release: pushed ${tagsToPush.join(', ')}`)
