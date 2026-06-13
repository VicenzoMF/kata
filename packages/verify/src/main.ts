#!/usr/bin/env tsx
/**
 * Executable entry for the `kata-verify` bin and the `verify` package script.
 * The only place in `@kata/verify` that touches `process` — all logic lives in
 * the pure {@link runCli} so it stays testable.
 */
import { runCli } from './cli'

const { output, exitCode } = runCli(process.argv.slice(2), process.cwd())
process.stdout.write(output)
process.exit(exitCode)
