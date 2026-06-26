// Issue #200 — the `.oxlintrc.json` a freshly `kata init`-ed project gets.
//
// Mirrors this repo's own oxlint ruleset (the `any` ban, no-default-export, etc.
// from AGENTS.md), trimmed of monorepo-only overrides. Shipped because the
// generated `lefthook.yml` runs `oxlint` on pre-commit; without this file (and
// the `oxlint` devDep) that hook would fail.
//
// Stored as a raw string (not an object run through `JSON.stringify`) so the
// bytes match Biome's JSON formatter exactly: Biome collapses short primitive
// arrays (`"plugins": ["typescript", "import"]`) onto one line, which
// `JSON.stringify` cannot, and the generated app ships `biome.json`. Kept valid
// JSON — the tests `JSON.parse` it to assert structure.

export const oxlintrcJson = `{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "import"],
  "categories": {
    "correctness": "error",
    "suspicious": "error",
    "perf": "warn",
    "style": "off"
  },
  "rules": {
    "typescript/no-explicit-any": "error",
    "import/no-default-export": "error",
    "no-unused-vars": "warn",
    "prefer-const": "warn",
    "no-console": "off"
  },
  "ignorePatterns": ["**/node_modules", "**/dist"],
  "overrides": [
    {
      "files": ["**/*.config.ts", "**/*.config.js"],
      "rules": {
        "import/no-default-export": "off"
      }
    }
  ]
}
`
