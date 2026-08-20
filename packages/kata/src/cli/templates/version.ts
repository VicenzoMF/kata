// The @katajs/core version installed alongside this CLI, read from the package's own
// manifest. Generated docs (AGENTS.md, the scaffolded ADR README) link to
// Kata's framework ADRs pinned to this version instead of `main`, so a project
// on an older release is never sent to a superseded decision (issue #213).
import pkg from '../../../package.json' with { type: 'json' }

export const KATA_VERSION: string = pkg.version
