/**
 * Shared types for `@kata/verify`.
 *
 * A rule is a pure function `(project) => Issue[]` — or, when it has coverage
 * gaps to declare, `(project) => { issues, suppressions }`. The runner builds
 * the {@link Project} (file list + parsed registry keys + AST cache) once and
 * feeds it to every rule, so rules never touch the filesystem and stay trivially
 * unit-testable.
 */
import type ts from 'typescript'

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

/**
 * A check a rule declined to perform because it could not resolve something it
 * depends on — an unreadable middleware expression, an indeterminate registry.
 *
 * Suppressions exist so a rule that *could not prove* a property is never
 * indistinguishable from one that *did* prove it: without this channel a single
 * unresolvable `cors()` in the app-level chain silently switched
 * `kata/scoped-slot-not-provided` off project-wide while the report still
 * printed a green checkmark (issue #206). They are reported, not fatal — until
 * `--strict-coverage`, which turns any suppression into a non-zero exit.
 */
export type Suppression = {
  /** Rule that suppressed itself. */
  readonly rule: string
  /** Why, phrased for a reader: "could not resolve `cors()` in createApp({ middlewares })". */
  readonly reason: string
  /** Path of the file holding the unresolvable expression, relative to the project root. */
  readonly file: string
  /** 1-based line. */
  readonly line: number
  /** 1-based column. */
  readonly column: number
  /**
   * How many checks the suppression swallowed — scoped reads left unverified,
   * for instance. `0` means the count itself was unknowable (the reads could not
   * be enumerated either), not that nothing was lost.
   */
  readonly affectedCount: number
}

/**
 * What a rule returns when it has coverage gaps to declare. Rules with nothing
 * to suppress may return a bare `Issue[]`; {@link normalizeRuleResult} in the
 * runner widens that to this shape.
 */
export type RuleResult = {
  readonly issues: readonly Issue[]
  readonly suppressions: readonly Suppression[]
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
 * What one exported middleware of an npm package contributes to a chain, as
 * declared by the package's `provides.json`.
 *
 * `provides: null` means "this export may fill slots we cannot enumerate" — the
 * same indeterminacy an unreadable local `provides` array carries.
 */
export type ManifestEntry = {
  readonly provides: readonly string[] | null
  /** Scoped slots the middleware reads. Absent means "reads nothing". */
  readonly reads?: readonly string[]
}

/**
 * A package's `provides.json`: the middleware contract of its public exports,
 * keyed by export subpath (`'.'`, `'./jwt'`) then by exported name.
 *
 * Shipping this is how `kata verify` resolves `cors()` — imported from a
 * compiled package whose source it cannot read — instead of giving up and
 * silently disabling `kata/scoped-slot-not-provided` project-wide (issue #206).
 * `katajs` generates its own at build time; any third-party middleware author
 * can ship the same file to become resolvable.
 */
export type ProvidesManifest = {
  readonly version: number
  readonly exports: Readonly<Record<string, Readonly<Record<string, ManifestEntry>>>>
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
  /**
   * Parse a file, reusing the tree when the same content was parsed before. The
   * single parse point for every rule — see `project.ts` for why the cache
   * exists and how watch mode shares it.
   */
  readonly ast: (file: SourceFile) => ts.SourceFile
  /**
   * The {@link ProvidesManifest} an installed package ships, or `null` when it
   * ships none (or is not installed). Injected rather than read from disk by the
   * rule, so rules stay pure and unit-testable; `buildProject` supplies the
   * disk-backed loader, tests supply a literal.
   */
  readonly packageManifest: (packageName: string) => ProvidesManifest | null
}

export type Rule = {
  readonly name: string
  /** One-line summary rendered by `--help`. Required so `--help` cannot drift from `rules`. */
  readonly description: string
  /** ADR this rule enforces, e.g. `'ADR-0004'`. */
  readonly adr: string
  readonly check: (project: Project) => readonly Issue[] | RuleResult
}

export type VerifyResult = {
  readonly issues: readonly Issue[]
  /** Checks no rule could perform, merged across rules. See {@link Suppression}. */
  readonly suppressions: readonly Suppression[]
  readonly errorCount: number
  readonly warningCount: number
  /** Number of source files scanned. */
  readonly fileCount: number
}

/**
 * JSON printed by `kata verify --json`, shaped for a Claude Code PostToolUse
 * hook. An empty object is the no-op output emitted when verification is clean
 * *and* nothing was suppressed.
 *
 * Three outcomes, not two:
 *  - clean → `{}`;
 *  - suppressions only → `additionalContext` describing the coverage gap, with
 *    no `decision`, so the agent learns which checks did not run without being
 *    blocked over code that may be perfectly correct (`--strict-coverage`
 *    upgrades this to a block for callers that want the gap fatal);
 *  - violations → `decision: 'block'` as before, with any suppressions appended
 *    to the same context.
 *
 * @see https://code.claude.com/docs/en/hooks — PostToolUse output schema.
 */
export type HookOutput =
  | Record<string, never>
  | {
      /** Set only when the agent must fix something before continuing. */
      readonly decision?: 'block'
      readonly reason?: string
      readonly hookSpecificOutput: {
        readonly hookEventName: 'PostToolUse'
        readonly additionalContext: string
      }
      /** Machine-readable coverage gaps, mirroring the prose in `additionalContext`. */
      readonly suppressions?: readonly Suppression[]
    }
