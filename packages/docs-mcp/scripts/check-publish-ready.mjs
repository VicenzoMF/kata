#!/usr/bin/env node
/**
 * Pre-publish guard (issue #280). `copy-docs.mjs` bundles `docs/` at build
 * time (ADR-0023) — the published tarball is a snapshot of whatever the
 * publisher's local checkout looked like, not a live read of the monorepo.
 * `0.1.0` and `0.1.1` both shipped built from a checkout that predated the
 * `katajs-v0.3.2` tag's doc fixes, with nothing in the toolchain to catch it.
 *
 * This fails a local `npm publish` (wired via `prepublishOnly`) when either:
 *
 *   1. the working tree is dirty — an uncommitted change could silently ship
 *      (or silently fail to ship, if it's a revert-in-progress);
 *   2. HEAD does not contain the latest `katajs-v*` tag — the snapshot would
 *      predate the release it's supposed to document, the exact failure mode
 *      above.
 *
 * Run standalone: `node scripts/check-publish-ready.mjs`
 */
import { execFileSync } from 'node:child_process'

const fail = (message) => {
  console.error(`check-publish-ready: FAIL — ${message}`)
  process.exitCode = 1
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const dirty = git(['status', '--porcelain'])
if (dirty.length > 0) {
  fail(
    'working tree is dirty — a publish built from this checkout would not match ' +
      `any commit:\n${dirty}`,
  )
} else {
  console.log('check-publish-ready: OK — working tree is clean')
}

const tags = git(['tag', '--list', 'katajs-v*', '--sort=-version:refname'])
  .split('\n')
  .filter(Boolean)
const latestTag = tags[0]

if (!latestTag) {
  console.log('check-publish-ready: no katajs-v* tags yet — skipping the behind-tag check')
} else {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', latestTag, 'HEAD'], { stdio: 'ignore' })
    console.log(`check-publish-ready: OK — HEAD contains ${latestTag}`)
  } catch {
    fail(
      `HEAD does not contain ${latestTag} (the latest core release tag) — this checkout's ` +
        'docs/ predates that release, so the published snapshot would too. Pull/rebase onto ' +
        `${latestTag} before publishing.`,
    )
  }
}

if (process.exitCode) {
  console.error('check-publish-ready: not ready to publish')
} else {
  console.log('check-publish-ready: ready to publish')
}
