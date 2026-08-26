// The @katajs-framework/core version installed alongside this CLI, read from the package's own
// manifest. Generated docs (AGENTS.md, the scaffolded ADR README) link to
// Kata's framework ADRs pinned to this version instead of `main`, so a project
// on an older release is never sent to a superseded decision (issue #213).
import pkg from '../../../package.json' with { type: 'json' }

export const KATA_VERSION: string = pkg.version

/** The git tag Kata's own releases are actually cut under — `katajs-v0.4.0`,
 *  not `v0.4.0` (that ref doesn't exist on the repo). Every generated doc that
 *  links to Kata's framework ADRs pinned to a version must build the URL from
 *  this constant rather than reconstructing the tag by string convention, so
 *  the two can't drift apart again (issue #301). */
export const KATA_ADR_TAG: string = `katajs-v${KATA_VERSION}`
