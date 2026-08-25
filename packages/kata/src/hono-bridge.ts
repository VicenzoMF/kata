/**
 * Hono type-boundary shim (ADR-0025, supersedes ADR-0019).
 *
 * Hono's `Context.get()` / `.set()` / `.json()` are typed against a
 * `Variables`/`Env` map the framework never instantiates the same way Kata
 * does, and Kata's own `MiddlewareContext<R>` / `RouteContext<R, I>` key
 * their `get()` / `set()` by a registry `R` that is sometimes still opaque
 * at the call site (a generic `R` a helper hasn't concretely resolved yet —
 * see `jwt/index.ts`'s `guard()` / `jwtAuth()`). Both shapes hit the same
 * wall: a runtime-string key the type system cannot prove belongs to the
 * map it is being read from or written to.
 *
 * `typedGet` / `typedSet` / `typedJson` are the ONLY place that wall is
 * crossed with a raw `as never` — `kata/no-raw-boundary-cast` enforces that
 * no other file in this package contains one. Call sites elsewhere stay
 * fully typed; the unsafe cast is contained to these three functions.
 */

/** Structural shape of anything with a Hono/Kata-style `get(key)`. */
type Gettable = { get(key: never): unknown }

/** Structural shape of anything with a Hono/Kata-style `set(key, value)`. */
type Settable = { set(key: never, value: never): void }

/**
 * Read `key` off `target` (a raw Hono `Context`, or a Kata `MiddlewareContext`/
 * `RouteContext` whose registry type is opaque at the call site), bypassing
 * its strict key typing. The caller supplies `T`; nothing here proves it.
 */
export function typedGet<T>(target: Gettable, key: string | symbol): T {
  // kata-allow: hono-boundary
  return target.get(key as never) as T
}

/**
 * Write `key`/`value` onto `target` (a raw Hono `Context`, or a Kata
 * `MiddlewareContext` whose registry type is opaque at the call site),
 * bypassing its strict key typing.
 */
export function typedSet(target: Settable, key: string | symbol, value: unknown): void {
  // kata-allow: hono-boundary
  target.set(key as never, value as never)
}

/**
 * Build a JSON response through Hono's `Context.json()`, bypassing its
 * strict body/status typing. `status` defaults to 200, matching Hono's own
 * default when the argument is omitted.
 */
export function typedJson<T>(target: import('hono').Context, body: T, status?: number): Response {
  // kata-allow: hono-boundary
  return target.json(body as never, (status ?? 200) as never)
}
