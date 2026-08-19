// `docs/adr/` for the generated app (issue #213). `kata init` scaffolds this
// app's own ADR directory, separate from Kata's own framework ADRs: copying
// the framework's decisions into every project would rot against the
// installed version and imply the app owns decisions it does not. `AGENTS.md`
// links to the framework's ADRs instead (see `agents-md.ts`); this directory
// is where the app records its own.

import { KATA_VERSION } from './version'

/** `docs/adr/_template.md` — the same ADR skeleton Kata itself uses, copied
 *  for the app's own decisions. Blocked from Claude edits by the generated
 *  harness's protected-config hook (ADR-0007-style: humans copy it to start a
 *  new ADR, they don't edit the template itself from an agent session). */
export const exampleAdrTemplateSource = `# ADR-NNNN: <Short noun phrase>

- **Status:** Proposed | Accepted | Superseded by ADR-MMMM | Deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** <names / handles>

## Context

What problem are we solving? What forces are in play (technical, organizational,
performance, DX)? What constraints?

## Decision

We will <decision in one sentence>.

Detail of the decision follows: APIs, interfaces, behavior, scope.

## Alternatives considered

### Alternative A — <name>
Brief description. Why rejected.

### Alternative B — <name>
Brief description. Why rejected.

## Consequences

### Positive
- ...

### Negative / costs
- ...

### Follow-ups
- Lint rules to create (with rule IDs)
- Tests to write
- Docs / examples to ship
- Related ADRs to draft
`

/** `docs/adr/README.md` for the generated app — distinguishes the app's own
 *  ADRs (this directory) from Kata's framework ADRs (a version-pinned link),
 *  so a reader never confuses the two (issue #213). */
export function exampleAdrReadme(): string {
  return `# Architectural decisions

This directory holds **this app's own** ADRs — decisions you make about your
domain, your infrastructure, your APIs. Copy \`_template.md\` to \`NNNN-slug.md\`
(next number, zero-padded) to start one.

Kata's own framework ADRs — why the framework itself works the way it does —
are not duplicated here. They live in the Kata repo, pinned to the version
this app depends on:
https://github.com/VicenzoMF/kata/tree/v${KATA_VERSION}/docs/adr
`
}
