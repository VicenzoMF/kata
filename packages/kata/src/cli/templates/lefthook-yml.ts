import { type PackageManager, pmCommands } from '../package-manager'

/** `lefthook.yml` — the local feedback layer, format/lint/typecheck on every
 *  commit (#130). `pm` is the package manager detected for the target project
 *  (issue #302): `exec` resolves a locally-installed bin (kata, biome, oxlint)
 *  the way `.claude/settings.json` already does (#231), and `run` resolves the
 *  `package.json` `typecheck` script — neither is hardcoded to pnpm, which
 *  would fail outright on a machine that only has the detected `pm` on PATH. */
export function lefthookYmlTemplate(pm: PackageManager): string {
  const { exec, run } = pmCommands(pm)
  return `# Local feedback layer — runs format/lint/typecheck on every commit.
# Article reference: "feedback speed determines quality".
#
# Humans can bypass any check with \`git commit --no-verify\`.
# Agents cannot — \`.claude/settings.json\` deny rule blocks the flag.

pre-commit:
  parallel: false # format must finish before lint reads the file
  commands:
    00-verify:
      # \`--strict-coverage\` also fails when a rule could not *prove* a check —
      # an unresolvable middleware expression, an indeterminate context registry.
      # Without it a coverage gap reads exactly like a passing check (issue #206).
      run: ${exec('kata verify --strict-coverage')}
    01-format-write:
      glob: '*.{ts,tsx,js,jsx,json}'
      run: ${exec('biome check --write --no-errors-on-unmatched {staged_files}')}
      stage_fixed: true
    02-lint:
      glob: '*.{ts,tsx,js,jsx}'
      run: ${exec('oxlint {staged_files}')}
    03-typecheck:
      # typecheck is project-wide (incremental TS); scoping to staged files is
      # unreliable since one file's change can break unrelated ones.
      run: ${run('typecheck')}

# Personal overrides go in lefthook-local.yml (gitignored).
`
}
