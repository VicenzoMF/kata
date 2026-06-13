#!/usr/bin/env tsx
/**
 * Executable entry for the `kata-verify` bin and the `verify` package script.
 * The only place in `@kata/verify` that touches `process` — all logic lives in
 * the pure {@link runCli} (single-shot) and {@link watchProject} (long-running).
 */
import { resolveTarget, runCli } from './cli'
import { watchProject } from './watch'

const argv = process.argv.slice(2)
const wantsHelp = argv.includes('--help') || argv.includes('-h')

if (argv.includes('--watch') && !wantsHelp) {
  // Long-running: render now and on every change. Never exits on its own.
  watchProject(resolveTarget(argv, process.cwd()))
} else {
  const { output, exitCode } = runCli(argv, process.cwd())
  process.stdout.write(output)
  process.exit(exitCode)
}
