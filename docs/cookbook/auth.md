# Recipe: Authentication & authorization

**Problem:** identify the caller, reject unauthenticated requests, make the
authenticated user available to every handler that needs it — without a global
variable and without threading the user through every function signature — and
then **authorize** specific routes by role or claim.

**Pattern:** a middleware that **provides a scoped slot**. This is exactly the
shape [ADR-0004](../adr/0004-di-via-scoped-slots.md) calls _Pattern C_: scoped
slots are declared up front in `defineContext`, and a middleware populates them
per request. A handler reads the user with `c.get('currentUser')` — the same
monomorphic accessor used for singletons.

Kata ships the JWT building blocks under [`kata/jwt`](../adr/0013-jwt-delivery.md),
so you no longer hand-roll a verifier:

| Function | Role |
| --- | --- |
| `signJwt(claims, opts)` | sign a claims object into a compact JWT |
| `verifyJwt(token, opts)` | verify + Zod-parse a token → a `Result` (never throws) |
| `jwtAuth(opts)` | a middleware **handler** that authenticates a request and fills a slot |
| `guard(opts)` / `requireRole(...)` / `requireClaim(...)` | middleware **handlers** that authorize (403) |

The reference app ships a working version in
[`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello/src) — auth middleware in
[`middlewares/auth.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/middlewares/auth.ts), the
token-minting route in
[`modules/auth`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/auth/auth.route.ts). This
recipe walks through it.

## 1. Declare the scoped slot

Scoped slots live in `defineContext` alongside singletons. `scoped<T>()` takes no
value — it only declares the type that a middleware will later `set`.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'kata'

import type { User } from './modules/users/users.schema'

export const k = defineContext({
  logger: singleton(makeLogger()),
  currentUser: scoped<User>(), // ← one User per request
})

export const { defineRoute, defineMiddleware, createApp } = k
```

## 2. Describe the token's claims

The payload inside a JWT is just data until you validate it. Declare a Zod schema
for the claims you expect; `jwtAuth` parses every decoded token through it, so an
attacker-controlled payload can never reach your handler as an untyped blob
(`any` is banned — see [AGENTS.md](https://github.com/VicenzoMF/kata/blob/main/AGENTS.md)). Schemas live in
`<domain>.schema.ts` ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)):

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

// `sub` is the standard JWT subject claim (the user id); `name`/`email` ride
// along as extra claims. Registered claims like `iat`/`exp` are stripped by this
// object schema.
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

export type User = z.infer<typeof UserSchema>
export type UserClaims = z.infer<typeof UserClaimsSchema>
```

## 3. Authenticate with `jwtAuth`

`jwtAuth` returns a middleware **handler** — it reads the `Authorization: Bearer <token>` header, verifies the signature and time claims, parses the payload through your
`claims` schema, and fills a scoped slot. You wrap it with `defineMiddleware`, so
the `provides` literal stays at the call site where the type system and the
`kata/middleware-provides-mismatch` lint rule can check it.

The **`resolve()` hook** maps the validated claims to the value that lands in the
slot. Because the `currentUser` slot is typed `User`, `resolve` turns the claims
into a `User`. Here the token already carries everything `User` needs, so it is a
pure reshape — but `resolve` is also the seam where a real app loads the full
user from its database by `claims.sub` (returning `null`/`undefined` for an
unknown subject renders a 401):

```ts
// src/middlewares/auth.ts
import { jwtAuth } from 'kata/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    // claims → User. In a real app: `resolve: (claims) => db.users.find(claims.sub)`.
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

`provides: ['currentUser'] as const` is load-bearing: the `as const` keeps the
literal key types so the type system and the `kata/jwt-auth-provides-slot` lint
rule can check that a `jwtAuth({ slot })` middleware declares the slot it fills.
`jwtAuth` does its `c.set` internally, so the generic
`kata/middleware-provides-mismatch` rule can't see the assignment —
`kata/jwt-auth-provides-slot` (ADR-0013) is what enforces this contract.

Every authentication failure short-circuits the chain with the unified ADR-0008
envelope as a **401** — the handler never runs:

| Situation | `error` | `message` |
| --- | --- | --- |
| no / malformed `Authorization` header | `unauthorized` | `Missing bearer token` |
| bad signature, wrong alg, expired | `unauthorized` | `Invalid or expired token` |
| payload fails `claims` | `unauthorized` | `Token claims did not match` (with `issues.claims`) |
| `resolve` returns `null`/`undefined` | `unauthorized` | `No such user` |

Invalid and expired collapse to one message on purpose: the endpoint is never a
validity oracle. Need a stricter token? `jwtAuth` also accepts `alg`, `issuer`,
`audience`, a custom `slot`, and a custom `header`.

## 4. Mint a token with `signJwt`

Verification needs something to verify. `signJwt` stamps `iat` and signs your
claims; the registered-claim options (`subject`, `expiresInSeconds`, `issuer`, …)
override same-named keys. The example exposes a tiny route so the test suite (and
you, with `curl`) can obtain a real token without external tooling:

```ts
// src/modules/auth/auth.route.ts
import { signJwt } from 'kata/jwt'

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

The signing key is shared by the minting route and the verifying middleware — if
they disagree, every token fails. A dev default keeps the example zero-config; a
real app must supply `JWT_SECRET` from the environment and never ship the
fallback:

```ts
// src/config.ts
export const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret'
export const TOKEN_TTL_SECONDS = 60 * 60
```

> This `/auth/token` route trusts its caller, so it is **not** how you
> authenticate real users — a production endpoint verifies credentials (or an
> OAuth code) before signing. It exists here to make the mint → verify loop
> runnable end to end.

## 5. Consume it in a route

A route opts into the middleware via `use: [...]`. Order matters — middlewares
run left to right. Once `requireUser` has run, `c.get('currentUser')` returns a
`User` synchronously inside the handler.

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

Returning the user value (not a `Response`) means Kata validates it against
`output` (`UserSchema`) before sending it — see [errors.md](./errors.md).

## Behaviour over the wire

This mirrors the `GET /me` cases asserted in
[`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl):

```http
POST /auth/token        {"id":"42","name":"Ada","email":"ada@example.com"}
→ 200  { "token": "eyJhbGc…" }

GET /me
→ 401  { "error": "unauthorized", "message": "Missing bearer token" }

GET /me
Authorization: Bearer eyJhbGc…
→ 200  { "id": "42", "name": "Ada", "email": "ada@example.com" }

GET /me
Authorization: Bearer not-a-real-jwt
→ 401  { "error": "unauthorized", "message": "Invalid or expired token" }
```

## 6. Authorize: guards that depend on the user

Authentication proves _who_ you are; **authorization** decides _what you may do_.
A guard reads a scoped slot it doesn't provide — as long as a middleware earlier
in the `use:` chain provided it — and rejects with a **403** when its predicate
says no. Its `provides` list is empty. The **order in the `use:` array is the
contract**: the guard must come _after_ the auth middleware that fills the slot.

Kata ships three guard handlers under `kata/jwt`:

- `requireRole(role | roles[])` — allow only when the slot value's `role` is (one of) `role`.
- `requireClaim(key, expected | predicate)` — allow only when a claim matches.
- `guard({ authorize })` — the general form; supply any predicate over the slot value.

Each carries a `role`/claim on the slot, so extend your claims (and `User`) with
the field you guard on:

```ts
// users.schema.ts — add a role to both the claims and the User
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['user', 'admin']),
})
```

```ts
// in a route — requireUser MUST come before the guard
import { requireRole } from 'kata/jwt'

export const adminRoute = defineRoute({
  method: 'GET',
  path: '/admin/metrics',
  use: [requireUser, requireRole('admin')], // 401 if unauthenticated, 403 if not admin
  input: {},
  output: MetricsSchema,
  handler: async (c) => collectMetrics(),
})
```

```http
GET /admin/metrics
Authorization: Bearer <token for a non-admin>
→ 403  { "error": "forbidden", "message": "Insufficient permissions" }
```

For anything role-based won't express, drop to `guard` with a custom predicate
(it may be `async`, and receives the middleware context as a second argument):

```ts
import { guard } from 'kata/jwt'

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

## Why scoped instead of a module-level variable

- **Per-request isolation.** A module global would leak one request's user into
  the next under concurrency. A scoped slot is stored per request.
- **Statically verifiable.** Because every read is `c.get('currentUser')` and
  every provider declares `provides: ['currentUser']`, the harness can prove that
  no route reads `currentUser` without an auth middleware in its chain — the
  `kata/scoped-slot-not-provided` rule (ADR-0004, _Companion rules_).
- **Explicit failure.** `jwtAuth` short-circuits with a `Response` on any
  failure; it cannot fall through and leave the slot unset.

## Gotchas

- **Reading a scoped slot with no provider throws at runtime.** If a handler
  calls `c.get('currentUser')` but no middleware in `use:` set it, Kata throws
  `kata: scoped slot 'currentUser' read before being set. Did the providing
  middleware run?`. The `kata/scoped-slot-not-provided` lint rule turns this into
  a build-time error.
- **`c.set` and `c.header` are middleware-only.** The route handler context has
  `c.get`, `c.input`, `c.json`, `c.error`, and `c.raw` — but no `set` (handlers
  consume slots, they don't fill them) and no `header` shortcut (read headers via
  an `input.headers` schema, or `c.raw.req.header(...)`).
- **Keep the secret out of the slot type.** `resolve` decides what lands in the
  slot; return your `User`, never the raw token or secret.
- **Don't read scoped slots at module load.** They only exist inside a request
  (enforced by the `kata/scoped-read-outside-request` rule).
```
