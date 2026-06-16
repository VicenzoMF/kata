#!/usr/bin/env node
// The `kata` binary. Intentionally thin: all logic lives in `cli.ts` (testable,
// no `process` access); this file just wires it to the real streams and exit
// code. Tests import `./cli`, never this module, so the top-level call below
// never runs under vitest.
//
// The one exception is `kata verify --watch`: it is long-running (never returns)
// so it is dispatched here — where process access already lives — rather than
// through the pure `run()`, exactly as `@kata/verify`'s own bin does.

import { resolveTarget, watchProject } from '@kata/verify'

import { run, verifyArgv } from './cli'

const argv = process.argv.slice(2)
const verifyArgs = verifyArgv(argv)
const wantsHelp = verifyArgs?.includes('--help') || verifyArgs?.includes('-h')

if (verifyArgs && verifyArgs.includes('--watch') && !wantsHelp) {
  // Long-running: render now and on every change. Never exits on its own.
  watchProject(resolveTarget(verifyArgs, process.cwd()))
} else {
  run(argv, process.cwd())
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
}
