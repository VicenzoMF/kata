// Which package manager the printed `kata init` next-steps should target
// (issue #214 item 3). `cli.ts` used to hardcode pnpm + a bare `kata` bin,
// which fails verbatim for anyone on npm/yarn/bun (`kata` is never on PATH
// after a local install).

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/**
 * Detect the package manager to print commands for. Priority:
 *  1. `npm_config_user_agent` — set by npm/pnpm/yarn/bun whenever they invoke
 *     a script or `dlx`/`npx`/`exec`, so it reflects the tool that actually
 *     ran `kata init`.
 *  2. A lockfile already present in `dir` (useful when re-running inside an
 *     existing project).
 *  3. `npm` — the one package manager guaranteed to exist wherever Node does.
 */
export function detectPackageManager(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PackageManager {
  const userAgent = env['npm_config_user_agent']
  if (userAgent) {
    for (const pm of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
      if (userAgent.startsWith(pm)) return pm
    }
  }
  for (const [lockfile, pm] of LOCKFILES) {
    if (existsSync(join(dir, lockfile))) return pm
  }
  return 'npm'
}

export type PackageManagerCommands = {
  install: string
  /** `pm run <script>` in whatever form that package manager spells it. */
  run: (script: string) => string
  /** Run a locally-installed bin that isn't a package.json script. */
  exec: (bin: string) => string
}

const COMMANDS: Record<PackageManager, PackageManagerCommands> = {
  npm: { install: 'npm install', run: (s) => `npm run ${s}`, exec: (c) => `npx ${c}` },
  pnpm: { install: 'pnpm install', run: (s) => `pnpm ${s}`, exec: (c) => `pnpm exec ${c}` },
  yarn: { install: 'yarn install', run: (s) => `yarn ${s}`, exec: (c) => `yarn ${c}` },
  bun: { install: 'bun install', run: (s) => `bun run ${s}`, exec: (c) => `bunx ${c}` },
}

export function pmCommands(pm: PackageManager): PackageManagerCommands {
  return COMMANDS[pm]
}
