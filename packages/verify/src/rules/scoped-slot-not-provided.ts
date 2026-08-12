/**
 * Rule: `kata/scoped-slot-not-provided` (issue #8, enforces ADR-0004; amended by
 * issue #88 / ADR-0012 to count app-level providers, and by issue #206 to walk
 * the chain in order and report what it could not check).
 *
 * A scoped slot (`scoped<T>()` in `defineContext`) is empty until a middleware
 * `c.set`s it. So anything that reads `c.get('<slot>')` — a route handler, or a
 * middleware further down the chain — must have a middleware whose `provides`
 * includes `'<slot>'` run *before* it. Otherwise the read resolves an unset slot
 * and throws at runtime (`scoped slot '<slot>' read before being set`). The type
 * system intentionally does not enforce this (see `RouteContext.get` in kata's
 * context.ts) — this rule does.
 *
 * ## The check is a chain walk, not a set union
 *
 * For each `defineRoute`, the effective chain is `[...createApp({ middlewares }),
 * ...use]` — the app-level chain runs before every route (ADR-0012), then the
 * route's own `use:` in order. The walk accumulates `provides` entry by entry:
 *
 *  - each entry's own scoped reads are checked against what the entries *before*
 *    it provide (plus its own `provides`, since a middleware may set a slot then
 *    read it back). That makes a wrong `use:` order an error rather than a
 *    runtime 500 — the constraint the whole DI design rests on;
 *  - a read placed after the entry's `next()` runs after everything downstream,
 *    so it is checked against the whole chain instead of the prefix;
 *  - the handler's reads are checked against the full chain, as before.
 *
 * ## When it cannot prove something, it says so
 *
 * A chain entry that cannot be resolved (see `middleware-graph.ts`) might supply
 * any slot, so no read after it can be *disproved*. Reads still satisfied by the
 * entries that did resolve pass; the rest become {@link Suppression}s carrying
 * the offending expression's location — reported by the CLI and fatal under
 * `--strict-coverage`. Before issue #206 this was silent and total: one `cors()`
 * in `createApp({ middlewares })` switched the rule off for the entire project
 * while `kata verify` still printed "no problems found".
 *
 * Suppressions (rather than issues) also cover: an indeterminate scoped registry,
 * a destructured handler context, a `use:`/`middlewares:` value that is not an
 * array literal, and a config object spread that could inject either.
 */
import ts from 'typescript'

import {
  collectSlotReads,
  createMiddlewareResolver,
  type MiddlewareResolver,
  type ResolvedMiddleware,
  type SlotRead,
} from '../middleware-graph'
import {
  forEachDescendant,
  functionProperty,
  hasSpread,
  isCalleeNamed,
  positionOf,
  propertyName,
  unwrapExpression,
} from '../parse'
import type { Issue, Project, Rule, RuleResult, SourceFile, Suppression } from '../types'

const NAME = 'kata/scoped-slot-not-provided'

/** A position in the verified project, as reported to the user. */
type Site = { readonly file: string; readonly line: number; readonly column: number }

/** One entry of a middleware chain, resolved or not, with where it was written. */
type ChainEntry = {
  /** The entry as written (`requireUser`, `cors()`), for messages. */
  readonly label: string
  readonly site: Site
  /** The contract behind it, or `null` when it could not be resolved. */
  readonly resolved: ResolvedMiddleware | null
  /** Why it could not be resolved — the suppression `reason`. Set iff `resolved` is null. */
  readonly reason?: string
}

export const scopedSlotNotProvided = {
  name: NAME,
  check(project): RuleResult {
    const scoped = project.scopedKeys
    if (scoped === null || scoped === undefined) {
      return { issues: [], suppressions: registrySuppression(project) }
    }
    // A determinate registry with no scoped slots: nothing to prove, nothing lost.
    if (scoped.size === 0) return { issues: [], suppressions: [] }

    const resolve = createMiddlewareResolver(project)
    const globals = globalChain(project, resolve)
    const out = createCollector(scoped)

    // Walk the app-level chain on its own so its ordering errors surface even in
    // a project with no routes. Only pre-`next()` reads are checked here: a
    // post-`next()` read in a global middleware can legitimately be satisfied by
    // a route's own `use:`, so it waits for the per-route walk below.
    out.walk(globals, [], { checkAfterNext: false })

    for (const file of project.files) {
      const sf = project.ast(file)
      forEachDescendant(sf, (node) => {
        if (!ts.isCallExpression(node) || !isCalleeNamed(node, 'defineRoute')) return
        const config = node.arguments[0]
        if (!config || !ts.isObjectLiteralExpression(config)) return

        const handler = functionProperty(config, 'handler')
        // A handler that is not a function literal keeps its reads elsewhere;
        // `kata/scoped-read-outside-request` is the rule that covers those.
        if (!handler) return

        const ctx = handler.parameters[0]
        if (ctx && !ts.isIdentifier(ctx.name)) {
          // Destructured ctx (`handler: ({ get }) => …`) — the reads cannot be
          // traced at all, so not even their number is known. A handler that
          // takes *no* context parameter is different: it provably reads nothing.
          out.suppress(
            siteOf(sf, file, ctx),
            'route handler context is destructured, so its scoped reads cannot be traced',
            0,
          )
          return
        }

        const chain = [...globals, ...useChain(config, file, sf, resolve)]
        out.walk(chain, collectSlotReads(handler, file, sf), { checkAfterNext: true })
      })
    }

    return out.result()
  },
} satisfies Rule

/**
 * Accumulates issues and suppressions across routes, deduplicating issues by
 * location and message: an app-level entry appears in every route's chain, and
 * one wrongly-ordered global middleware is one problem, not one per route.
 */
function createCollector(scoped: ReadonlySet<string>) {
  const issues: Issue[] = []
  const suppressions: Suppression[] = []
  const seen = new Set<string>()

  const add = (issue: Issue): void => {
    const key = `${issue.file}:${issue.line}:${issue.column}:${issue.message}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(issue)
  }

  const suppress = (site: Site, reason: string, affectedCount: number): void => {
    suppressions.push({ rule: NAME, reason, ...site, affectedCount })
  }

  /**
   * Walk one chain in order, checking every scoped read it can and recording
   * what it cannot. `handlerReads` are the route handler's reads (empty for the
   * standalone app-level walk).
   */
  const walk = (
    chain: readonly ChainEntry[],
    handlerReads: readonly SlotRead[],
    options: { checkAfterNext: boolean },
  ): void => {
    const provided = new Set<string>()
    /** The first entry that could not be resolved: everything after it is unprovable. */
    let blocked: ChainEntry | undefined
    /** Reads left unchecked, counted per blocking entry for the suppression report. */
    let unchecked = 0
    /** Post-`next()` reads, held back until the whole chain's provides are known. */
    const deferred: { entry: ChainEntry; read: SlotRead }[] = []

    // Pass 1 — accumulate provides, checking each entry's pre-`next()` reads
    // against the prefix that precedes it.
    for (const entry of chain) {
      const resolved = entry.resolved
      if (!resolved || resolved.provides === null) {
        blocked ??= entry
        continue
      }

      for (const read of resolved.reads) {
        if (!scoped.has(read.key)) continue
        if (read.afterNext) {
          if (options.checkAfterNext) deferred.push({ entry, read })
          continue
        }
        // A middleware may set a slot and read it back, so its own provides count.
        if (provided.has(read.key) || resolved.provides.has(read.key)) continue
        if (blocked) unchecked += 1
        else add(chainReadIssue(entry, read, scoped, 'before'))
      }

      for (const key of resolved.provides) provided.add(key)
    }

    // Pass 2 — reads that observe the finished chain: a middleware's own
    // post-`next()` reads, then the route handler's.
    for (const { entry, read } of deferred) {
      if (provided.has(read.key)) continue
      if (blocked) unchecked += 1
      else add(chainReadIssue(entry, read, scoped, 'anywhere'))
    }
    for (const read of handlerReads) {
      if (!scoped.has(read.key) || provided.has(read.key)) continue
      if (blocked) unchecked += 1
      else add(handlerReadIssue(read, scoped))
    }

    if (blocked && unchecked > 0) {
      suppress(blocked.site, blocked.reason ?? unresolvedReason(blocked.label), unchecked)
    }
  }

  return { walk, suppress, result: (): RuleResult => ({ issues, suppressions }) }
}

// ── chain construction ─────────────────────────────────────────────────────

/**
 * The app-level chain: every `createApp({ middlewares: [...] })` in the project,
 * concatenated. Kata apps declare one; concatenating several is safe because an
 * entry is only ever judged against the entries listed before it, and merging
 * chains can only *add* providers to that prefix.
 *
 * A `createApp` whose config cannot be read might still declare a chain, so it
 * contributes an unresolved entry rather than nothing.
 */
function globalChain(project: Project, resolve: MiddlewareResolver): ChainEntry[] {
  const entries: ChainEntry[] = []
  for (const file of project.files) {
    const sf = project.ast(file)
    forEachDescendant(sf, (node) => {
      if (!ts.isCallExpression(node) || !isCalleeNamed(node, 'createApp')) return

      const config = node.arguments[0]
      if (!config || !ts.isObjectLiteralExpression(config) || hasSpread(config)) {
        entries.push({
          label: 'createApp(…)',
          site: siteOf(sf, file, config ?? node),
          resolved: null,
          reason:
            'could not read createApp({ … }) — its config is not a plain object literal, so an app-level middlewares chain may be hidden in it',
        })
        return
      }

      const member = config.properties.find((m) => propertyName(m) === 'middlewares')
      if (!member) return // no app-level chain on this app → contributes nothing
      if (!ts.isPropertyAssignment(member)) {
        entries.push({
          label: 'middlewares',
          site: siteOf(sf, file, member),
          resolved: null,
          reason: 'could not read the middlewares: property of createApp({ … })',
        })
        return
      }
      entries.push(...listEntries(member.initializer, file, sf, resolve, GLOBAL))
    })
  }
  return entries
}

/** A route's own `use:` chain, in declaration order. */
function useChain(
  config: ts.ObjectLiteralExpression,
  file: SourceFile,
  sf: ts.SourceFile,
  resolve: MiddlewareResolver,
): ChainEntry[] {
  if (hasSpread(config)) {
    return [
      {
        label: 'defineRoute(…)',
        site: siteOf(sf, file, config),
        resolved: null,
        reason:
          'could not read defineRoute({ … }) — a spread in its config could inject a use: chain',
      },
    ]
  }

  const member = config.properties.find((m) => propertyName(m) === 'use')
  if (!member) return [] // no `use:` → determinately empty
  if (!ts.isPropertyAssignment(member)) {
    return [
      {
        label: 'use',
        site: siteOf(sf, file, member),
        resolved: null,
        reason: `could not read the use: property of ${USE}`,
      },
    ]
  }
  return listEntries(member.initializer, file, sf, resolve, USE)
}

const GLOBAL = 'createApp({ middlewares })'
const USE = "this route's use: chain"

/** Resolve every element of a middleware array literal into a chain entry. */
function listEntries(
  value: ts.Expression,
  file: SourceFile,
  sf: ts.SourceFile,
  resolve: MiddlewareResolver,
  where: string,
): ChainEntry[] {
  const list = unwrapExpression(value)
  if (!ts.isArrayLiteralExpression(list)) {
    return [
      {
        label: labelOf(list),
        site: siteOf(sf, file, list),
        resolved: null,
        reason: `could not read ${where} — it is not an array literal, so its middlewares are unknown`,
      },
    ]
  }

  return list.elements.map((element) => {
    const label = labelOf(element)
    const site = siteOf(sf, file, element)
    if (ts.isSpreadElement(element)) {
      return {
        label,
        site,
        resolved: null,
        reason: `could not resolve \`${label}\` in ${where} — a spread can contribute any middleware`,
      }
    }
    const resolved = resolve(element, file)
    return resolved
      ? { label, site, resolved }
      : { label, site, resolved: null, reason: `could not resolve \`${label}\` in ${where}` }
  })
}

// ── reporting ──────────────────────────────────────────────────────────────

/**
 * The project's registry could not be read, so no scoped read was checked at
 * all — reported, since "proved nothing" must not look like "proved it".
 *
 * Nothing is reported for a directory that declares no route and no app: there
 * is no chain to walk there, so no check was lost. That keeps `kata verify` from
 * inventing a coverage gap when it is pointed at a library (kata's own package
 * has a `src/context.ts` that *defines* `defineContext` rather than calling it).
 */
function registrySuppression(project: Project): Suppression[] {
  if (!declaresApp(project)) return []
  return [
    {
      rule: NAME,
      reason:
        'the context registry is indeterminate — src/context.ts has no defineContext({ … }) call, or a spread inside it hides the scoped slots, so no scoped read could be checked',
      file: 'src/context.ts',
      line: 1,
      column: 1,
      affectedCount: 0,
    },
  ]
}

/** Does anything here define a route or an app — i.e. is there a chain to check? */
function declaresApp(project: Project): boolean {
  for (const file of project.files) {
    let found = false
    forEachDescendant(project.ast(file), (node) => {
      if (found || !ts.isCallExpression(node)) return
      if (isCalleeNamed(node, 'defineRoute') || isCalleeNamed(node, 'createApp')) found = true
    })
    if (found) return true
  }
  return false
}

function siteOf(sf: ts.SourceFile, file: SourceFile, node: ts.Node): Site {
  const { line, column } = positionOf(sf, node)
  return { file: file.relPath, line, column }
}

/** The entry's source text, collapsed to one line and clipped for a message. */
function labelOf(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, ' ').trim()
  return text.length > 48 ? `${text.slice(0, 45)}…` : text
}

function unresolvedReason(label: string): string {
  return `could not resolve \`${label}\``
}

/** A middleware in the chain reads a slot the chain does not (yet) provide. */
function chainReadIssue(
  entry: ChainEntry,
  read: SlotRead,
  scoped: ReadonlySet<string>,
  position: 'before' | 'anywhere',
): Issue {
  const where =
    position === 'before'
      ? "no middleware earlier in this route's chain provides it"
      : "no middleware in this route's chain provides it"
  const readAt = read.line > 0 ? ` The read is at ${read.file}:${read.line}:${read.column}.` : ''
  return {
    rule: NAME,
    severity: 'error',
    ...entry.site,
    message: `middleware \`${entry.label}\` reads scoped slot c.get('${read.key}') but ${where}`,
    why: `ADR-0004 (Pattern C) + ADR-0012: a scoped slot is empty until a middleware c.sets it, and a chain runs in order — the app-level \`createApp({ middlewares })\` entries first, then the route's \`use:\` entries. A middleware that reads '${read.key}' before any entry ahead of it provides the slot throws at runtime ("scoped slot '${read.key}' read before being set"), no matter that some *later* entry sets it.${readAt}`,
    fix: `Move the middleware that provides '${read.key}' ahead of \`${entry.label}\` in the chain — earlier in this route's \`use: [...]\`, or into \`createApp({ middlewares: [...] })\`, which runs before every route. Scoped slots in this project: ${slotList(scoped)}.`,
    example: {
      bad: [
        'defineRoute({',
        "  // requireOrg reads c.get('currentUser') — but it runs first",
        '  use: [requireOrg, requireUser],',
        '  // …',
        '})',
      ].join('\n'),
      good: [
        'defineRoute({',
        "  // requireUser sets 'currentUser' before requireOrg reads it",
        '  use: [requireUser, requireOrg],',
        '  // …',
        '})',
      ].join('\n'),
    },
  }
}

/** A route handler reads a slot nothing in its chain provides. */
function handlerReadIssue(read: SlotRead, scoped: ReadonlySet<string>): Issue {
  return {
    rule: NAME,
    severity: 'error',
    file: read.file,
    line: read.line,
    column: read.column,
    message: `route reads scoped slot c.get('${read.key}') but no middleware in its use: chain provides it`,
    why: `ADR-0004 (Pattern C): a scoped slot is empty until a middleware c.sets it. Reading c.get('${read.key}') with no providing middleware in the route's \`use:\` chain — nor in the app-level \`createApp({ middlewares })\` chain that runs before it (ADR-0012) — throws at runtime ("scoped slot '${read.key}' read before being set").`,
    fix: `Add a middleware that provides '${read.key}' so it runs before this read — a defineMiddleware declaring \`provides: ['${read.key}']\` that c.sets it — either in this route's \`use: [...]\` array or app-wide in \`createApp({ middlewares: [...] })\` (ADR-0012). Scoped slots in this project: ${slotList(scoped)}.`,
    example: {
      bad: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/me',",
        '  input: {},',
        '  output: UserSchema,',
        "  handler: (c) => c.get('currentUser'), // no middleware provides currentUser",
        '})',
      ].join('\n'),
      good: [
        'defineRoute({',
        "  method: 'GET',",
        "  path: '/me',",
        "  use: [authMiddleware], // provides: ['currentUser']",
        '  input: {},',
        '  output: UserSchema,',
        "  handler: (c) => c.get('currentUser'),",
        '})',
      ].join('\n'),
    },
  }
}

function slotList(scoped: ReadonlySet<string>): string {
  return [...scoped].sort().join(', ')
}
