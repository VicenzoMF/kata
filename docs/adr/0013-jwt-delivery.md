# ADR-0013: JWT delivery shape + lib

- **Status:** Accepted
- **Date:** 2026-06-15
- **Deciders:** @VicenzoMF

## Context

Kata's v0.3 milestone ("production ergonomics") promotes authentication from the
toy `x-user-id` shim in `examples/hello/src/middlewares/auth.ts` to a real,
first-party JWT story (Epic #89, this ADR is #90; implementation follows in
#91–#93). The cookbook already prescribes the *integration* shape — a middleware
that verifies a token and populates a `currentUser` scoped slot
(`docs/cookbook/auth.md`, ADR-0004 _Pattern C_) — but leaves the verifier itself
("`verifyToken` is your code, not framework API") to the app. This ADR decides
what Kata ships in that gap, **before** any code is written.

Four forces are in play:

1. **Dependency weight.** Kata's thesis is a small, dependency-light, mechanically
   inspectable surface. `hono` and `zod` are already `peerDependencies` of the
   core `kata` package; anything new is a real cost.
2. **Cross-runtime.** ADR-0001 commits Kata to Node / Bun / Deno / Workers / edge.
   Any crypto must be Web Crypto based, not Node-only.
3. **Functional facade.** ADR-0002 bans classes and hidden control flow in
   Kata-owned `src/`. Whatever lib we pick must be wrappable in plain functions.
4. **Verifiability.** ADR-0004's scoped-slot invariants are enforced by static
   lint rules that read `provides: [...]` literals and `c.set` calls. Any auth
   helper must not hide that wiring from the rules.

Two questions must be answered together, because they are coupled: **which lib**,
and **where the code lives** (a separate published package vs a subpath of core).

### Current state of the candidate libs (docs pulled 2026-06-15)

The issue framed the lib choice as "`hono/jwt` (zero new dep, **limited alg
support**) vs `jose` (gold standard, extra dep)". Pulling current docs at
decision time (as #90 instructs) updates that premise materially:

- **`hono/jwt`** exposes plain async functions `sign(payload, secret, alg?)` and
  `verify(token, secret, alg?)`, and now supports a **comprehensive** algorithm
  set: `HS256/384/512`, `RS256/384/512`, `PS256/384/512`, `ES256/384/512`, and
  `EdDSA`. Hono additionally ships a separate **`hono/jwk`** middleware for
  **remote JWKS** (`jwks_uri`, `kid` matching, asymmetric-alg allowlist, time-claim
  validation). It is Web Crypto based — the same primitive the Hono HTTP layer
  already uses. "Limited alg support" is no longer accurate.
- **`jose`** (`/panva/jose`) is the gold-standard JOSE implementation (JWA/JWS/
  JWE/JWK/JWKS), zero-runtime-dependency, runs on every target runtime, with
  excellent types and `createRemoteJWKSet` / `createLocalJWKSet`. Its JWT path is
  a **class builder** (`new SignJWT(...).setProtectedHeader(...).sign(key)`) plus
  a throwing `jwtVerify(...)`.

So the practical completeness gap that would have justified `jose` has largely
closed for the surface Kata intends to ship first-party; `jose`'s remaining edge
(JWE, deep JWK manipulation, remote JWKS as a first-class feature) sits on the
far side of the v0.3 **framework-vs-BYO boundary**.

## Decision

We will ship JWT as a **`kata/jwt` subpath export of the core package**, built on
**`hono/jwt`**, exposing a small functional surface whose verify/sign primitives
are a deliberately swappable seam.

### 1. Lib — `hono/jwt`

- **Zero new dependency.** `hono` is already a `peerDependency` of `kata`;
  `hono/jwt` rides on it. Combined with the subpath boundary below, this adds *no*
  new dependency anywhere.
- **Runtime + cadence symmetry.** Same Web Crypto base and same release cadence as
  the HTTP layer ADR-0001 already couples us to — one fewer moving part to track
  for security patches.
- **Functional already.** `sign`/`verify` are plain async functions; they wrap
  directly into Kata's functional facade (ADR-0002) with no class-builder
  indirection. `jose`'s `new SignJWT()` would need a wrapper to hide the class.
- **Good-enough algorithms.** HS/RS/PS/ES + EdDSA covers the symmetric and
  asymmetric cases real apps need; remote JWKS is available via `hono/jwk`.

`signJwt` / `verifyJwt` (below) are the **only** code that imports `hono/jwt`. If
a future need (JWE, exotic JWK rotation, or a `hono/jwt` regression) demands it,
those two functions can be re-implemented against `jose` **without a breaking
change** to the public signatures.

### 2. Boundary — `kata/jwt` subpath, not a separate `@kata/auth` package

- With `hono/jwt` there is **no extra dependency to quarantine**, which is the
  single strongest reason a separate package would exist.
- A subpath is **ESM tree-shakeable**: an app that never `import`s `kata/jwt` pays
  nothing in its bundle.
- Auth code lives **next to the types it depends on** — `Middleware<R>['handler']`,
  `MiddlewareContext`, `ScopedKeys`, and the ADR-0008 error envelope — with no
  cross-package `peerDependency` on `kata` to version-coordinate.
- The "mirror `@kata/verify`" framing is a **false analogy**: `@kata/verify` is
  `private: true`, source-only, build-time *tooling* that apps never install; it
  is split out because it is a dev CLI with its own `bin`, not because runtime
  concerns demanded it. Auth is **published runtime code** that composes with
  core's runtime types, so it belongs *with* core.

Concretely: a new `src/jwt/index.ts` tsup entry, a `"./jwt"` block in the package
`exports` map, and `splitting: true` in `tsup.config.ts` (or accepting minor
duplication) so `kata` and `kata/jwt` do not each inline the shared error/type
helpers.

### 3. Public surface (`kata/jwt`)

All four are functions (ADR-0002). Types reference the existing `FieldIssue`
(ADR-0008) and the registry types (`Registry`, `ScopedKeys`, `Middleware`,
`MiddlewareContext`) already exported from `kata`.

```ts
import type { z } from 'zod'
import type { FieldIssue, Middleware, MiddlewareContext, Registry } from 'kata'

export type JwtAlgorithm =
  | 'HS256' | 'HS384' | 'HS512'
  | 'RS256' | 'RS384' | 'RS512'
  | 'PS256' | 'PS384' | 'PS512'
  | 'ES256' | 'ES384' | 'ES512'
  | 'EdDSA'

// ── 3a. Stateless primitives (no Kata context) ────────────────────────────────

export type SignOptions = {
  secret: string
  alg?: JwtAlgorithm          // default 'HS256'
  expiresInSeconds?: number   // sets `exp = iat + expiresInSeconds`
  notBeforeSeconds?: number   // sets `nbf`
  issuer?: string             // `iss`
  audience?: string           // `aud`
  subject?: string            // `sub`
}

/** Sign a claims object into a compact JWT. Thin functional wrapper over hono/jwt `sign`. */
export function signJwt(claims: Record<string, unknown>, options: SignOptions): Promise<string>

export type VerifyOptions<S extends z.ZodTypeAny> = {
  secret: string
  /** Schema the decoded payload must satisfy. Its `z.infer` is the success type. */
  claims: S
  alg?: JwtAlgorithm
  issuer?: string
  audience?: string
}

export type JwtErrorCode = 'invalid_token' | 'expired' | 'claims_mismatch'

export type JwtError = {
  readonly code: JwtErrorCode
  readonly message: string
  /** Present only when `code === 'claims_mismatch'` — reuses the ADR-0008 shape. */
  readonly issues?: FieldIssue[]
}

export type JwtVerifyResult<T> =
  | { readonly ok: true; readonly claims: T }
  | { readonly ok: false; readonly error: JwtError }

/**
 * Verify signature + time claims (via hono/jwt), then parse the payload through
 * `claims`. Returns a Result rather than throwing: an invalid/expired token is a
 * normal, expected outcome, not an exception (contrast `signJwt`, which rejects
 * only on a misconfigured key — a programmer error). Class-free and explicit
 * (ADR-0002).
 */
export function verifyJwt<S extends z.ZodTypeAny>(
  token: string,
  options: VerifyOptions<S>,
): Promise<JwtVerifyResult<z.infer<S>>>

// ── 3b. Kata integration (middleware *handlers*) ──────────────────────────────

export type JwtAuthOptions<S extends z.ZodTypeAny> = {
  secret: string
  /** Schema the JWT payload must satisfy; its `z.infer` becomes the slot value. */
  claims: S
  /** Scoped slot to populate with the validated claims. Default `'currentUser'`. */
  slot?: string
  alg?: JwtAlgorithm
  issuer?: string
  audience?: string
  /** Request header to read the bearer token from. Default `'authorization'`. */
  header?: string
}

/**
 * Build a Kata middleware *handler* that authenticates via JWT and writes the
 * validated claims into a scoped slot. Mirrors `fromHono`
 * (`packages/kata/src/middlewares/from-hono.ts`): it returns the handler, and the
 * caller owns the `defineMiddleware({ provides: [...] })` wrapper — so the
 * `provides: ['currentUser']` literal stays at the call site, where the ADR-0004
 * rules (`scoped-slot-not-provided`, `middleware-provides-mismatch`) can read it.
 */
export function jwtAuth<R extends Registry, S extends z.ZodTypeAny>(
  options: JwtAuthOptions<S>,
): Middleware<R>['handler']

export type GuardOptions<R extends Registry, C = unknown> = {
  /** Slot the guard reads (must be provided earlier in the chain). Default `'currentUser'`. */
  slot?: string
  /** Predicate over the slot value; return false to reject with 403. */
  authorize: (claims: C, c: MiddlewareContext<R>) => boolean | Promise<boolean>
  code?: string     // 403 envelope `error` code. Default 'forbidden'
  message?: string  // 403 envelope message. Default 'Insufficient permissions'
}

/**
 * Build an authorization guard *handler* that reads an already-provided slot and
 * rejects with a 403 ADR-0008 envelope when `authorize` returns false. Like the
 * cookbook's `requireAdmin`, it provides nothing — wire it with
 * `provides: [] as const` AFTER the auth middleware in the route's `use:` array.
 */
export function guard<R extends Registry, C = unknown>(
  options: GuardOptions<R, C>,
): Middleware<R>['handler']
```

Usage keeps the verifiable wiring at the call site:

```ts
// src/modules/users/users.schema.ts  (schemas live here — ADR-0005)
export const UserClaims = z.object({
  sub: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(['user', 'admin']),
})

// src/context.ts  — slot type is the claims type
// currentUser: scoped<z.infer<typeof UserClaims>>()

// src/middlewares/auth.ts
import { defineMiddleware } from '../context'
import { jwtAuth, guard } from 'kata/jwt'
import { UserClaims } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,                 // ← greppable, lint-checked
  handler: jwtAuth({ secret: process.env.JWT_SECRET!, claims: UserClaims }),
})

export const requireAdmin = defineMiddleware({
  provides: [] as const,                              // reads currentUser, provides nothing
  handler: guard<AppRegistry, z.infer<typeof UserClaims>>({
    authorize: (user) => user.role === 'admin',
  }),
})
```

### 4. Claims → scoped slot

This is exactly ADR-0004 _Pattern C_, with Kata now owning the verifier:

1. The app declares the slot in `defineContext` typed as the claims schema's
   inferred type: `currentUser: scoped<z.infer<typeof UserClaims>>()`.
2. `jwtAuth({ secret, claims })` reads the `authorization` header, strips the
   `Bearer ` prefix, runs `verifyJwt`, and on success `c.set('currentUser', claims)`
   — where `claims` is the **Zod-validated** payload, never a raw `any` (the
   `any` ban is satisfied because the payload passes through `UserClaims` first).
3. Handlers read `c.get('currentUser')` and receive the typed value synchronously
   (ADR-0004: `c.get` is monomorphic).

The one seam: that the `slot` string is a real scoped key **and** that
`z.infer<claims>` matches the slot's declared type is not enforced by `jwtAuth`'s
signature (TypeScript cannot infer the registry `R` from the options object). It
is enforced by the `provides: ['currentUser']` literal at the call site plus lint
— precisely the posture ADR-0004 already documents for scoped reads (see the
`RouteContext` note in `packages/kata/src/context.ts`). A companion rule closes
it (below).

### 5. Failure → ADR-0008 envelope (401 / 403)

`jwtAuth` translates every authentication failure into `c.error(...)`, which
builds the unified ADR-0008 envelope. Authentication failures are **401**;
authorization failure (the guard) is **403**:

| Condition | Rendered as |
|---|---|
| Missing / malformed `Authorization: Bearer` header | `c.error('unauthorized', 'Missing bearer token', { status: 401 })` |
| `verifyJwt` → `invalid_token` or `expired` | `c.error('unauthorized', 'Invalid or expired token', { status: 401 })` |
| `verifyJwt` → `claims_mismatch` | `c.error('unauthorized', 'Token claims did not match', { status: 401, issues })` |
| `guard` predicate returns false | `c.error('forbidden', 'Insufficient permissions', { status: 403 })` |

`invalid_token` and `expired` collapse to one generic 401 message — avoiding a
validity oracle, consistent with ADR-0008 Alt. D ("the client never sees internal
detail"). For `claims_mismatch`, the structured `issues` are produced by the
existing `formatZodIssues` helper, keyed under `claims`, so they ride the
envelope's `issues` field for free. Over the wire (mirrors `docs/cookbook/auth.md`):

```http
GET /me                                  → 401  { "error": "unauthorized", "message": "Missing bearer token" }
GET /me  Authorization: Bearer <bad>     → 401  { "error": "unauthorized", "message": "Invalid or expired token" }
GET /me  Authorization: Bearer <valid>   → 200  { "id": "...", "name": "...", "email": "..." }
```

## Alternatives considered

### Alternative A — `jose` instead of `hono/jwt`
The gold-standard JOSE implementation: full JWA/JWS/JWE/JWK/JWKS, superb types,
zero runtime deps, every runtime. Rejected as the default because (1) it is one
new dependency where `hono/jwt` is none; (2) current docs show `hono/jwt` already
covers HS/RS/PS/ES/EdDSA and Hono ships remote-JWKS via `hono/jwk`, so jose's
completeness edge is small for the surface Kata ships first; (3) its JWT API is a
class builder (`new SignJWT()`) that we would wrap away anyway. It remains the
documented swap target behind `signJwt`/`verifyJwt` if JWE / advanced JWK / a
`hono/jwt` regression ever demands it; apps needing remote JWKS *today* can mount
`hono/jwk` via `fromHono`, or call jose in a custom verify (the BYO boundary).

### Alternative B — separate `@kata/auth` published package (mirror `@kata/verify`)
Clean dependency isolation and independent versioning. Rejected: with `hono/jwt`
there is no extra dependency to isolate, so the main reason to split evaporates;
the package would have to `peerDependency` on `kata` and track its internal types
(`Middleware<R>['handler']`, `ScopedKeys`, the error envelope), adding
release-coordination friction; and the `@kata/verify` analogy is false — verify is
`private`, source-only, build-time tooling apps never install, whereas auth is
published runtime code. Revisit if auth later grows a dependency worth
quarantining (e.g. adopting jose) or a release cadence that diverges from core.

### Alternative C — `jwtAuth` returns a full `Middleware<R>` (or a `createJwtAuth(define)` factory)
Less call-site boilerplate. Rejected: it hides the `provides: [...]` literal inside
the package, where the `kata/scoped-slot-not-provided` and
`kata/middleware-provides-mismatch` static rules cannot see it. Keeping `provides`
at the call site is the entire point of ADR-0004's mechanically-verifiable wiring;
the handler-factory shape (mirroring `fromHono`) preserves it for one line of
boilerplate.

### Alternative D — `verifyJwt` throws on failure (matching hono/jwt and jose)
Throwing matches both underlying libs and is conventional for verifiers. Rejected
for the public primitive: an invalid/expired token is an expected outcome, not an
exception, and a `Result` keeps control flow explicit and class-free (ADR-0002) —
no augmented-`Error` type, no try/catch leaking into app code. `signJwt` is the
deliberate exception: it rejects, because a signing failure is a misconfigured-key
programmer error with no caller-handled branch.

## Consequences

### Positive
- **Zero new dependency** (hono is already a peer dep); `kata/jwt` is a
  tree-shakeable subpath — non-auth apps pay nothing.
- `signJwt` / `verifyJwt` are a **swappable seam**: re-implementable against jose
  with no breaking change to the surface.
- Auth wiring stays **greppable and lint-checkable** (`provides` at the call site),
  consistent with ADR-0004 and the `fromHono` precedent.
- Failures reuse the **ADR-0008 envelope** and `formatZodIssues` — one error shape;
  `claims_mismatch` gets structured `issues` for free.
- Fully **functional** (ADR-0002): `signJwt` / `verifyJwt` / `jwtAuth` / `guard`
  are functions; no class leaks into Kata `src/`.

### Negative / costs
- A second tsup entry (`src/jwt/index.ts`) and a `"./jwt"` block in `exports`;
  needs `splitting: true` (or accepts minor duplication) so `kata` and `kata/jwt`
  do not each inline shared error/type helpers.
- The slot-type ↔ claims-schema match is **not** enforced by `jwtAuth`'s signature
  (the `R`/slot inference wrinkle); it leans on `provides` + lint + a planned
  tightening — the same trade-off ADR-0004 already accepts for scoped reads.
- Couples the algorithm set and behaviour to `hono/jwt` (shared with the ADR-0001
  base); a regression or a missing feature (JWE) forces the jose swap.
- No **remote-JWKS** in the first-party surface; JWKS / OIDC providers
  (Auth0, Cognito, Clerk) are BYO (`hono/jwk` via `fromHono`, or jose) until a
  later ADR promotes them past the v0.3 framework-vs-BYO boundary.

### Follow-ups
- Implement in #91–#93: `src/jwt/` (`signJwt` / `verifyJwt`), `jwtAuth`, `guard`,
  a `users.hurl` E2E for the 401 / 403 / 200 cases, the `kata/jwt` export wiring,
  and `tsup` `splitting`.
- Lint rule `kata/jwt-auth-provides-slot` (see below).
- Update `docs/cookbook/auth.md` to use `jwtAuth` / `guard` (replacing the toy
  `verifyToken`), and migrate the example app's `fakeAuth` → `jwtAuth`.
- Decide a distinct `token_expired` code (vs the generic 401) for client refresh
  flows in the implementation ADR.
- Revisit remote-JWKS / OIDC as its own ADR if it leaves the BYO boundary.

## Companion rules

Mechanical enforcement of this ADR will live in `0013.rules.ts` (archgate
pattern), to be implemented with the `kata verify` rule engine. Rule IDs
introduced by this ADR:

- `kata/jwt-auth-provides-slot` — a `defineMiddleware` whose `handler` is a
  `jwtAuth({ slot: 'x', ... })` call must declare `provides: ['x']` (default
  `'currentUser'` when `slot` is omitted). This is the `jwtAuth`-specific analogue
  of `kata/middleware-provides-mismatch`, which keys on literal `c.set` calls it
  cannot see through the `jwtAuth` indirection. (The deeper
  `z.infer<claims>`-assignable-to-slot-type check is left to `tsc`; tightening it
  to a rule is a noted follow-up.)
