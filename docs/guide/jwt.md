---
title: JWT auth
description: Authenticate requests with kata/jwt — sign and verify tokens, fill a scoped currentUser slot via jwtAuth, and authorize with role and claim guards.
---

# JWT auth

A **JWT** (JSON Web Token) is a compact, signed string that carries a set of
*claims* — facts about the caller, such as "user id 42, email ada@…". Because it is
signed with a secret only your server knows, the server can trust those claims after
a cheap signature check — no session store, no database round-trip.

`katajs/jwt` ships the building blocks for that flow so you do not hand-roll a verifier:
**sign** a token, **verify** it, **authenticate** a request into a scoped slot, and
**authorize** that slot with guards. It adds **no new dependency** — `katajs/jwt` is a
tree-shakeable subpath built on `hono/jwt`, and `hono` is already a peer dependency
([ADR-0013](/adr/0013-jwt-delivery)).

```ts
import {
  signJwt,
  verifyJwt,
  jwtAuth,
  guard,
  requireRole,
  requireClaim,
} from 'katajs/jwt'
```

Everything here is a function. No classes, no decorators, no IoC container. An
invalid or expired token is a normal outcome, not an exception — so `verifyJwt`
returns a `Result`, and `jwtAuth` renders the unified error envelope instead of
throwing.

::: info What Kata does NOT ship
Login, password hashing, the user store, refresh-token rotation, sessions, and
remote JWKS / OIDC providers (Auth0, Cognito, Clerk) are **yours**. `katajs/jwt`
is the verify-and-authorize seam; the credential and identity model is BYO. See
[What you own](#what-you-own) below.
:::

## The four pieces

| Function | Role |
| --- | --- |
| `signJwt(claims, opts)` | sign a claims object into a compact JWT |
| `verifyJwt(token, opts)` | verify + Zod-parse a token → a `Result` (never throws) |
| `jwtAuth(opts)` | a middleware **handler** that authenticates a request and fills a scoped slot |
| `guard(opts)` / `requireRole(...)` / `requireClaim(...)` | middleware **handlers** that authorize (403) |

`signJwt` and `verifyJwt` are the stateless primitives — they know nothing about
Kata's context. `jwtAuth` and the guards are the Kata-aware layer: they return a
middleware **handler** (not a full middleware), so you keep the
`defineMiddleware({ provides: [...] })` wrapper at the call site where the type
system and lint can read it.

## Describe the claims

A JWT payload is untyped data until you validate it. Declare a Zod schema for the
claims you expect; `jwtAuth` parses every decoded token through it, so an
attacker-controlled payload can never reach a handler as an untyped blob (the
`any` type is forbidden). Schemas live in `<domain>.schema.ts`.

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

// `sub` is the standard JWT subject claim (the user id); `name`/`email` ride
// along as extra claims. Registered claims like `iat`/`exp` are stripped by
// this object schema.
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

export type UserClaims = z.infer<typeof UserClaimsSchema>
```

## Sign a token: `signJwt`

`signJwt` is a thin functional wrapper over `hono/jwt`'s `sign`. It always stamps
`iat` (issued-at = now). The registered-claim options below derive their claims
and **override** any same-named key in the first argument.

```ts
signJwt(claims: Record<string, unknown>, options: SignOptions): Promise<string>
```

`SignOptions`:

| Field | Type | Effect |
| --- | --- | --- |
| `secret` | `string` | signing key (required) |
| `alg?` | `JwtAlgorithm` | signing algorithm. Default `'HS256'` |
| `expiresInSeconds?` | `number` | sets `exp = iat + expiresInSeconds` |
| `notBeforeSeconds?` | `number` | sets `nbf = iat + notBeforeSeconds` |
| `issuer?` | `string` | sets the `iss` claim |
| `audience?` | `string` | sets the `aud` claim |
| `subject?` | `string` | sets the `sub` claim |

`JwtAlgorithm` is `HS256/384/512`, `RS256/384/512`, `PS256/384/512`,
`ES256/384/512`, or `EdDSA`.

```ts
// src/modules/auth/auth.route.ts
import { signJwt } from 'katajs/jwt'

import { JWT_SECRET, TOKEN_TTL_SECONDS } from '../../config'
import { defineRoute } from '../../context'
import { TokenRequestSchema, TokenResponseSchema } from './auth.schema'

export const mintTokenRoute = defineRoute({
  method: 'POST',
  path: '/auth/token',
  input: { body: TokenRequestSchema }, // { id, name, email }
  output: TokenResponseSchema, // { token }
  handler: async (c) => {
    const { id, name, email } = c.input.body
    const token = await signJwt(
      { name, email },
      { secret: JWT_SECRET, subject: id, expiresInSeconds: TOKEN_TTL_SECONDS },
    )
    return { token }
  },
})
```

`signJwt` rejects only on a misconfigured key or algorithm — a programmer error
with no caller-handled branch. That is the deliberate asymmetry with `verifyJwt`,
which returns a `Result`.

::: warning This is not login
This route trusts its caller, so it is **not** how you authenticate real users —
it exists so the example (and its Hurl suite) can obtain a token without external
tooling. A production endpoint verifies credentials (or an OAuth code) **before**
signing. See [What you own](#what-you-own).
:::

## Verify a token: `verifyJwt`

`verifyJwt` checks the signature and time claims (and `iss` / `aud` when supplied)
via `hono/jwt`, then parses the payload through your `claims` schema. It returns a
discriminated `Result` — it never throws.

```ts
verifyJwt<S extends z.ZodTypeAny>(
  token: string,
  options: VerifyOptions<S>,
): Promise<JwtVerifyResult<z.infer<S>>>
```

`VerifyOptions` takes `secret`, `claims` (the schema; its `z.infer` is the
success type), and optional `alg` (default `'HS256'`), `issuer`, and `audience`.
When `issuer` / `audience` are set, the matching claim is required.

```ts
const result = await verifyJwt(token, {
  secret: JWT_SECRET,
  claims: UserClaimsSchema,
})

if (result.ok) {
  result.claims // typed UserClaims
} else {
  result.error.code // 'invalid_token' | 'expired' | 'claims_mismatch'
}
```

The error shape:

```ts
type JwtErrorCode = 'invalid_token' | 'expired' | 'claims_mismatch'

type JwtError = {
  readonly code: JwtErrorCode
  readonly message: string
  // present only for 'claims_mismatch' — the same FieldIssue[] shape as the
  // validation error envelope
  readonly issues?: FieldIssue[]
}
```

Three buckets, so a caller always knows which kind of failure happened:

- a signature, structure, algorithm, `iss`, `aud`, or not-before failure →
  `invalid_token`
- an expired token → `expired`
- a payload that fails the Zod schema → `claims_mismatch` (carrying structured
  `issues`)

You rarely call `verifyJwt` directly in route code — `jwtAuth` wraps it. Reach
for it when you verify a token outside the request middleware chain (a background
job, a websocket upgrade, a CLI).

## Authenticate a request: `jwtAuth`

`jwtAuth` is the Kata-aware layer over `verifyJwt`. It reads
`Authorization: Bearer <token>`, verifies it, and writes the result into a
**scoped slot**. It returns a middleware **handler** — you own the
`defineMiddleware({ provides: [...] })` wrapper, so the `provides` literal stays
greppable and lint-checkable at the call site.

### 1. Declare the slot

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import type { User } from './modules/users/users.schema'

export const k = defineContext({
  logger: singleton(logger),
  currentUser: scoped<User>(), // one User per request
})

export const { defineRoute, defineMiddleware, createApp } = k
export type AppRegistry = typeof k.registry
```

### 2. Wire `jwtAuth`

```ts
// src/middlewares/auth.ts
import { jwtAuth } from 'katajs/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    // claims → User. In a real app: load from your store by claims.sub.
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

`provides: ['currentUser'] as const` is load-bearing. The `as const` preserves
the literal key so the type system and the `kata/jwt-auth-provides-slot` lint
rule can verify a `jwtAuth({ slot })` middleware declares the slot it fills.
Because `jwtAuth` does its `c.set` internally, the generic
`kata/middleware-provides-mismatch` rule can't see the assignment — so
`kata/jwt-auth-provides-slot` (ADR-0013) is the rule that checks the slot wiring here.

`JwtAuthOptions`:

| Field | Type | Effect |
| --- | --- | --- |
| `secret` | `string` | verification key (required) |
| `claims` | `z.ZodTypeAny` | schema the payload must satisfy (required) |
| `slot?` | `string` | scoped slot to fill. Default `'currentUser'` |
| `alg?` | `JwtAlgorithm` | expected algorithm. Default `'HS256'` |
| `issuer?` | `string` | when set, require this `iss` |
| `audience?` | `string` | when set, require this `aud` |
| `header?` | `string` | header to read the token from. Default `'authorization'` |
| `resolve?` | `(claims, c) => user` | map claims → the value stored in the slot |

### The `resolve` hook

Without `resolve`, the slot holds the **Zod-validated claims** verbatim. With
`resolve`, it holds whatever you return — and the slot's type becomes that value,
not `z.infer<claims>`. It runs after claims validation and receives the
middleware context as a second argument, so it may be `async`:

```ts
handler: jwtAuth({
  secret: JWT_SECRET,
  claims: UserClaimsSchema,
  resolve: async (claims, c) => c.get('db').users.findById(claims.sub),
})
```

This is the seam where a real app loads the full user from its store by
`claims.sub`. Returning `null` or `undefined` means "valid token, but no such
user" and renders a **401** — distinct from a 403, which is an authorization
decision a guard makes.

::: tip Keep secrets out of the slot
`resolve` decides what lands in the slot. Return your `User`; never the raw token
or the signing secret.
:::

### 3. Consume the slot in a route

A route opts in via `use: [...]`. Once `requireUser` has run, `c.get('currentUser')`
returns the typed value synchronously.

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

import { UserSchema } from './users.schema'

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
```

### Authentication failures (401)

Every authentication failure short-circuits the chain with the unified error
envelope as a **401** — the handler never runs:

| Situation | `error` | `message` |
| --- | --- | --- |
| no / malformed `Authorization` header | `unauthorized` | `Missing bearer token` |
| bad signature, wrong alg, expired | `unauthorized` | `Invalid or expired token` |
| payload fails `claims` | `unauthorized` | `Token claims did not match` (with `issues.claims`) |
| `resolve` returns `null` / `undefined` | `unauthorized` | `No such user` |

Invalid and expired collapse to one message on purpose: the endpoint is never a
validity oracle.

```http
GET /me
→ 401  { "error": "unauthorized", "message": "Missing bearer token" }

GET /me
Authorization: Bearer eyJhbGc…
→ 200  { "id": "42", "name": "Ada", "email": "ada@example.com" }

GET /me
Authorization: Bearer not-a-real-jwt
→ 401  { "error": "unauthorized", "message": "Invalid or expired token" }
```

## Authorize: guards (403)

Authentication proves _who_ you are; authorization decides _what you may do_. A
guard reads a scoped slot it does **not** provide, and rejects with a **403** when
its predicate says no. Its `provides` list is empty, so wire it with
`provides: [] as const`. The order in the `use:` array is the contract: the guard
must come **after** the middleware that fills the slot.

```ts
// in a route — requireUser MUST come before the guard
import { requireRole } from 'katajs/jwt'

export const adminRoute = defineRoute({
  method: 'GET',
  path: '/admin/metrics',
  use: [requireUser, requireRole('admin')], // 401 if unauthenticated, 403 if not admin
  input: {},
  output: MetricsSchema,
  handler: async (c) => collectMetrics(),
})
```

Guard on a field, so extend your claims (and the slot type) with it:

```ts
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['user', 'admin']),
})
```

### `requireRole`

```ts
requireRole(role: string | readonly string[], options?: { slot?: string })
```

Allows only when the slot value's `role` is (one of) `role`. Reads the default
`currentUser` slot. A non-admin gets:

```http
GET /admin/metrics
Authorization: Bearer <token for a non-admin>
→ 403  { "error": "forbidden", "message": "Insufficient permissions" }
```

### `requireClaim`

```ts
requireClaim(
  key: string,
  expected: unknown | ((value: unknown) => boolean),
  options?: { slot?: string },
)
```

Allows only when the slot value's claim at `key` matches `expected` — by strict
equality, or by predicate when `expected` is a function.

```ts
import { requireClaim } from 'katajs/jwt'

// require a verified email
const requireVerified = defineMiddleware({
  provides: [] as const,
  handler: requireClaim('email_verified', true),
})

// or with a predicate
const requirePaidPlan = defineMiddleware({
  provides: [] as const,
  handler: requireClaim('plan', (v) => v === 'pro' || v === 'team'),
})
```

### `guard`

The general form. Supply any predicate over the slot value; it may be `async` and
receives the middleware context as a second argument.

```ts
guard<R, C>(options: GuardOptions<R, C>)
```

`GuardOptions`: `authorize` (the predicate, required), `slot?` (default
`'currentUser'`), `code?` (default `'forbidden'`), and `message?` (default
`'Insufficient permissions'`).

```ts
import { guard } from 'katajs/jwt'

// Only the owner of the resource may read it.
const requireOwner = defineMiddleware({
  provides: [] as const,
  handler: guard<AppRegistry, User>({
    authorize: (user, c) => user.id === c.raw.req.param('id'),
    code: 'forbidden',
    message: 'Not your resource',
  }),
})
```

`requireRole` and `requireClaim` are thin sugar over `guard`.

## What you own

`katajs/jwt` deliberately stops at the verify-and-authorize boundary. The
credential and identity model is BYO:

- **Login.** Verify credentials (or an OAuth code) in your own route, then call
  `signJwt`. The example's `/auth/token` trusts its caller and is a stand-in, not
  a login.
- **Password hashing.** Kata ships no hashing. Use a vetted library (argon2,
  bcrypt, scrypt) in your service layer.
- **User store.** `resolve` is the seam to load a user by `claims.sub` from your
  database. Kata does not provide one.
- **Refresh tokens.** Rotation, revocation lists, and refresh-token storage are
  yours. `signJwt` produces a stateless access token; everything stateful around
  it is app code.
- **Remote JWKS / OIDC.** Auth0, Cognito, Clerk, and JWKS verification sit beyond
  the v0.3 framework-vs-BYO boundary. Mount `hono/jwk` via `fromHono`, or call a
  library such as `jose` in a custom verify ([ADR-0013](/adr/0013-jwt-delivery)).

## Why a scoped slot, not a global

- **Per-request isolation.** A module global would leak one request's user into
  the next under concurrency. A scoped slot is stored per request.
- **Statically verifiable.** Every read is `c.get('currentUser')` and every
  provider declares `provides: ['currentUser']`, so the harness can prove no route
  reads `currentUser` without an auth middleware in its chain — the
  `kata/scoped-slot-not-provided` rule.
- **Explicit failure.** `jwtAuth` short-circuits with a `Response` on any failure;
  it cannot fall through and leave the slot unset.

## See also

- [Auth recipe](/cookbook/auth) — the end-to-end walkthrough this page condenses.
- [`katajs/jwt` reference](/reference/jwt) — full signatures.
- [Middleware & scoped slots](/guide/middleware) — how `provides` and `use:` compose.
- [Errors](/guide/errors) — the unified error envelope guards and `jwtAuth` render.
- [ADR-0013](/adr/0013-jwt-delivery) — why `hono/jwt`, why a subpath, the BYO boundary.
