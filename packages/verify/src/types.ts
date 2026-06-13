/**
 * Shared types for `@kata/verify`.
 *
 * A rule is a pure function `(project) => Issue[]`. The runner builds the
 * {@link Project} (file list + parsed registry keys) once and feeds it to every
 * rule, so rules never touch the filesystem and stay trivially unit-testable.
 */

export type Severity = 'error' | 'warning'

/**
 * One rule violation. Carries the full ERROR / WHY / FIX / EXAMPLE payload so a
 * formatter can render an agent-actionable message (harness-engineering
 * best-practices template) without re-deriving anything.
 */
export type Issue = {
  readonly rule: string
  readonly severity: Severity
  /** Path of the offending file, relative to the verified project root. */
  readonly file: string
  /** 1-based line. */
  readonly line: number
  /** 1-based column. */
  readonly column: number
  /** ERROR: one-line statement of what is wrong. */
  readonly message: string
  /** WHY: why the rule exists, with an ADR reference. */
  readonly why: string
  /** FIX: concrete remediation steps. */
  readonly fix: string
  /** EXAMPLE: a bad/good code pair. */
  readonly example: { readonly bad: string; readonly good: string }
}

/** A source file picked up for analysis. */
export type SourceFile = {
  /** Absolute path on disk. */
  readonly path: string
  /** Path relative to the project root (used in issue output). */
  readonly relPath: string
  readonly text: string
}

/**
 * The analysed project: every candidate source file plus the set of context
 * registry keys parsed from `src/context.ts`.
 *
 * `registryKeys` is `null` when the registry could not be determined (no
 * `src/context.ts`, no `defineContext` call, or a spread that makes the key set
 * indeterminate). Rules that depend on it must no-op in that case so the
 * false-positive rate stays at zero.
 */
export type Project = {
  readonly root: string
  readonly files: readonly SourceFile[]
  readonly registryKeys: ReadonlySet<string> | null
  /**
   * The subset of {@link registryKeys} declared as request-scoped slots
   * (`scoped<T>()`). `null` when the registry is indeterminate; `undefined` when
   * a caller did not compute it. Either way, scoped-slot rules no-op, keeping the
   * false-positive rate at zero (ADR-0004).
   */
  readonly scopedKeys?: ReadonlySet<string> | null
}

export type Rule = {
  readonly name: string
  readonly check: (project: Project) => readonly Issue[]
}

export type VerifyResult = {
  readonly issues: readonly Issue[]
  readonly errorCount: number
  readonly warningCount: number
  /** Number of source files scanned. */
  readonly fileCount: number
}

/**
 * JSON printed by `kata verify --json`, shaped for a Claude Code PostToolUse
 * hook. An empty object is the no-op output emitted when verification is clean.
 *
 * @see https://code.claude.com/docs/en/hooks — PostToolUse output schema.
 */
export type HookOutput =
  | Record<string, never>
  | {
      readonly decision: 'block'
      readonly reason: string
      readonly hookSpecificOutput: {
        readonly hookEventName: 'PostToolUse'
        readonly additionalContext: string
      }
    }
