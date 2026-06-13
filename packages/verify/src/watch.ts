/**
 * Watch mode for `kata verify` (issue #10). Re-checks on file changes, re-reading
 * only the file that changed.
 *
 * Re-running the rules needs the whole project in memory (the registry and the
 * scoped-slot / middleware-provides rules are cross-file), so naive per-file rule
 * evaluation would be unsound. Instead a {@link WatchSession} holds the built
 * project and, on each change, refreshes just the one changed file before
 * re-running the rules — the hot loop touches disk for a single file, keeping it
 * comfortably under the per-change budget while staying correct for cross-file
 * rules.
 *
 * {@link createWatchSession} is the pure, testable core. {@link watchProject}
 * wires it to `fs.watch`; the watcher is injectable so the wiring is testable
 * without real filesystem events.
 */
import { existsSync, watch as fsWatch, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import { formatHuman } from './format'
import { isAnalysable } from './fs-walk'
import { extractRegistryKeys, extractScopedKeys } from './registry'
import { buildProject, verifyProject } from './runner'
import type { Project, SourceFile, VerifyResult } from './types'

export type WatchSession = {
  readonly targetDir: string
  /** Verify the current in-memory project. */
  verify(): VerifyResult
  /** Refresh the single changed file (add / update / remove), then re-verify. */
  update(changedPath: string): VerifyResult
}

/**
 * Build the project once, then keep it in memory so each change re-reads only the
 * file that changed. A change to `src/context.ts` also refreshes the registry and
 * scoped-slot sets that several rules depend on.
 */
export function createWatchSession(targetDir: string): WatchSession {
  const initial = buildProject(targetDir)
  const files = new Map<string, SourceFile>(initial.files.map((file) => [file.path, file]))
  let registryKeys = initial.registryKeys
  let scopedKeys = initial.scopedKeys

  const contextPath = join(targetDir, 'src', 'context.ts')

  const snapshot = (): Project => ({
    root: targetDir,
    files: [...files.values()],
    registryKeys,
    scopedKeys,
  })

  return {
    targetDir,
    verify: () => verifyProject(snapshot()),
    update(changedPath: string): VerifyResult {
      if (isAnalysable(basename(changedPath))) {
        if (existsSync(changedPath)) {
          files.set(changedPath, {
            path: changedPath,
            relPath: relative(targetDir, changedPath),
            text: readFileSync(changedPath, 'utf8'),
          })
        } else {
          files.delete(changedPath)
        }
      }

      if (changedPath === contextPath) {
        const source = existsSync(contextPath) ? readFileSync(contextPath, 'utf8') : null
        registryKeys = source !== null ? extractRegistryKeys(source) : null
        scopedKeys = source !== null ? extractScopedKeys(source) : null
      }

      return verifyProject(snapshot())
    },
  }
}

export type WatchRenderer = (
  result: VerifyResult,
  changed: string | null,
  elapsedMs: number,
) => void

type WatchListener = (event: string, filename: string | null) => void
type WatchHandle = { close(): void }
type WatchFn = (
  dir: string,
  options: { recursive?: boolean },
  listener: WatchListener,
) => WatchHandle

export type WatchOptions = {
  /** Injectable `fs.watch` for tests. Defaults to the real recursive watcher. */
  watch?: WatchFn
  /** Where reports go. Defaults to a terminal renderer on stdout. */
  render?: WatchRenderer
  /** Monotonic clock for the per-change timing line. Defaults to `performance.now`. */
  now?: () => number
  /** Coalesce bursts of events; `<= 0` runs synchronously (used by tests). */
  debounceMs?: number
}

/**
 * Start watching `targetDir/src`, rendering a report now and after every change.
 * Returns a stop function that closes the watcher.
 */
export function watchProject(targetDir: string, options: WatchOptions = {}): () => void {
  const session = createWatchSession(targetDir)
  const render = options.render ?? defaultRenderer
  const now = options.now ?? (() => performance.now())
  const watch = options.watch ?? defaultWatch
  const debounceMs = options.debounceMs ?? 30
  const srcDir = join(targetDir, 'src')

  render(session.verify(), null, 0)

  const recheck = (changedPath: string): void => {
    const start = now()
    const result = session.update(changedPath)
    render(result, relative(targetDir, changedPath), now() - start)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const handle = watch(srcDir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const changedPath = join(srcDir, filename)
    if (debounceMs <= 0) {
      recheck(changedPath)
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => recheck(changedPath), debounceMs)
  })

  return () => {
    if (timer) clearTimeout(timer)
    handle.close()
  }
}

const defaultWatch: WatchFn = (dir, opts, listener) =>
  fsWatch(dir, opts, (event, filename) =>
    listener(event, typeof filename === 'string' ? filename : null),
  )

function defaultRenderer(result: VerifyResult, changed: string | null, elapsedMs: number): void {
  const header =
    changed === null
      ? '\n👀 kata verify --watch — watching for changes (Ctrl-C to stop)\n\n'
      : `\n✎ ${changed} — re-checked in ${elapsedMs.toFixed(1)}ms\n\n`
  process.stdout.write(header + formatHuman(result))
}
