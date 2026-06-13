#!/usr/bin/env node
// The `kata` binary. Intentionally thin: all logic lives in `cli.ts` (testable,
// no `process` access); this file just wires it to the real streams and exit
// code. Tests import `./cli`, never this module, so the top-level call below
// never runs under vitest.
//
// Relative imports in this CLI carry explicit `.js` extensions: the built
// output is Node-ESM (`"type": "module"`), whose resolver requires them. They
// resolve to the `.ts` siblings under tsx/vitest and tsc's Bundler resolution.

import { run } from './cli.js'

run(process.argv.slice(2))
  .then((result) => {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(result.code)
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`kata: ${message}\n`)
    process.exit(1)
  })
