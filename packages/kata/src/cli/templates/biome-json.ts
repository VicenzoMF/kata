// Issue #200 — the `biome.json` a freshly `kata init`-ed project gets.
//
// Mirrors this repo's own Biome config (formatter on, linter off — oxlint is the
// linter), trimmed of monorepo-only ignores. Shipped because the generated
// `lefthook.yml` runs `biome check` on pre-commit; without this file (and the
// `@biomejs/biome` devDep) that hook would fail. Serialised as an object so the
// emitted bytes already match Biome's own JSON formatter.

export const biomeJsonTemplate = {
  $schema: './node_modules/@biomejs/biome/configuration_schema.json',
  vcs: {
    enabled: true,
    clientKind: 'git',
    useIgnoreFile: true,
  },
  files: {
    ignoreUnknown: true,
    includes: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.json',
      '!**/node_modules',
      '!**/dist',
    ],
  },
  formatter: {
    enabled: true,
    indentStyle: 'space',
    indentWidth: 2,
    lineWidth: 100,
    lineEnding: 'lf',
  },
  linter: {
    enabled: false,
  },
  javascript: {
    formatter: {
      quoteStyle: 'single',
      trailingCommas: 'all',
      semicolons: 'asNeeded',
      arrowParentheses: 'always',
      bracketSpacing: true,
    },
  },
  json: {
    formatter: {
      trailingCommas: 'none',
    },
  },
  assist: {
    enabled: true,
    actions: {
      source: {
        organizeImports: 'on',
      },
    },
  },
}
