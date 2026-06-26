---
title: kata/jwt
description: Signature reference for kata/jwt — signJwt, verifyJwt, jwtAuth, the guards, and every exported type.
---

# kata/jwt

`kata/jwt` is the auth subpath of the `kata` package. It ships the stateless JWT
primitives — `signJwt` / `verifyJwt` — plus the Kata-aware `jwtAuth` middleware
and the authorization guards. It is the only module that imports `hono/jwt`, so
it adds no dependency beyond the `hono` peer ([ADR-0013](/adr/0013-jwt-delivery)).

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

Everything is a function. An invalid or expired token is an expected outcome,
not an exception: `verifyJwt` returns a discriminated `Result`, and `jwtAuth`
renders the unified error envelope rather than throwing.

This page is the signature reference. For the narrative — declaring the claims
schema, wiring `jwtAuth` into a scoped slot, ordering guards in `use:` — see
[JWT auth](/guide/jwt). For the end-to-end login pattern, see the
[Authentication cookbook](/cookbook/auth).

## `signJwt`

```ts
signJwt(claims: Record<string, unknown>, options: SignOptions): Promise<string>
```

Sign a claims object into a compact JWT — a thin functional wrapper over
`hono/jwt`'s `sign`. It always stamps `iat` (issued-at = now). The registered
claims derived from `options` (`exp`, `nbf`, `iss`, `aud`, `sub`) **override** any
same-named key in `claims`.

`signJwt` rejects only on a misconfigured key or algorithm — a programmer error
with no caller-handled branch. That is the deliberate asymmetry with `verifyJwt`,
which returns a `Result`.

### `SignOptions`

```ts
type SignOptions = {
  secret: string
  alg?: JwtAlgorithm
  expiresInSeconds?: number
  notBeforeSeconds?: number
  issuer?: string
  audience?: string
  subject?: string
}
```

| Field | Type | Effect |
| --- | --- | --- |
| `secret` | `string` | Signing key (required). |
| `alg?` | `JwtAlgorithm` | Signing algorithm. Default `'HS256'`. |
| `expiresInSeconds?` | `number` | Sets `exp = iat + expiresInSeconds`. |
| `notBeforeSeconds?` | `number` | Sets `nbf = iat + notBeforeSeconds`. |
| `issuer?` | `string` | Sets the `iss` claim. |
| `audience?` | `string` | Sets the `aud` claim. |
| `subject?` | `string` | Sets the `sub` claim. |

```ts
const token = await signJwt(
  { name: 'Ada', email: 'ada@example.com' },
  { secret: JWT_SECRET, subject: 'u1', expiresInSeconds: 900 },
)
```

## `verifyJwt`

```ts
verifyJwt<S extends z.ZodTypeAny>(
  token: string,
  options: VerifyOptions<S>,
): Promise<JwtVerifyResult<z.infer<S>>>
```

Verify the signature and time claims (and `iss` / `aud` when supplied) via
`hono/jwt`, then parse the decoded payload through `options.claims`. Returns a
discriminated `Result` — it never throws.

A signature, structure, algorithm, `iss`, `aud`, or not-before failure collapses
to `invalid_token`; an expired token to `expired`; a payload that fails the Zod
schema to `claims_mismatch` (carrying structured `issues`). The collapse is
deliberate: `verifyJwt` is never a validity oracle.

You rarely call `verifyJwt` directly in route code — `jwtAuth` wraps it. Reach
for it to verify a token outside the request middleware chain (a background job,
a websocket upgrade, a CLI).

### `VerifyOptions`

```ts
type VerifyOptions<S extends z.ZodTypeAny> = {
  secret: string
  claims: S
  alg?: JwtAlgorithm
  issuer?: string
  audience?: string
}
```

| Field | Type | Effect |
| --- | --- | --- |
| `secret` | `string` | Verification key (required). |
| `claims` | `S extends z.ZodTypeAny` | Schema the decoded payload must satisfy. Its `z.infer` is the success type (required). |
| `alg?` | `JwtAlgorithm` | Expected signing algorithm. Default `'HS256'`. |
| `issuer?` | `string` | When set, require this `iss` claim. |
| `audience?` | `string` | When set, require this `aud` claim. |

### Result and error shapes

```ts
type JwtVerifyResult<T> =
  | { readonly ok: true; readonly claims: T }
  | { readonly ok: false; readonly error: JwtError }

type JwtErrorCode = 'invalid_token' | 'expired' | 'claims_mismatch'

type JwtError = {
  readonly code: JwtErrorCode
  readonly message: string
  // present only when code === 'claims_mismatch' — the same FieldIssue[] shape
  // as the validation error envelope
  readonly issues?: FieldIssue[]
}
```

```ts
const result = await verifyJwt(token, {
  secret: JWT_SECRET,
  claims: UserClaimsSchema,
})

if (result.ok) {
  result.claims // typed z.infer<typeof UserClaimsSchema>
} else {
  result.error.code // 'invalid_token' | 'expired' | 'claims_mismatch'
}
```

`FieldIssue` is the core export from `kata` reused here (`{ path, message, code,
expected?, received? }`); see [Errors](/guide/errors).

## `jwtAuth`

```ts
jwtAuth<R extends Registry, S extends z.ZodTypeAny>(
  options: JwtAuthOptions<S, R>,
): Middleware<R>['handler']
```

Build a middleware **handler** that authenticates a request via JWT. It reads
`Authorization: Bearer <token>` (header configurable), runs `verifyJwt`, and on
success writes the validated claims — or, with `resolve`, the value you return —
into a scoped slot. The bearer scheme match is case-insensitive (RFC 7235).

`jwtAuth` returns the **handler only**. Wrap it yourself with
`defineMiddleware({ provides: [slot] as const, handler })` so the `provides`
literal stays at the call site where the type system and the
`kata/scoped-slot-not-provided` lint rule can read it. `R` is not inferable from
`options`; the slot's membership in `ScopedKeys<R>` and that its declared type
matches `z.infer<S>` (or the `resolve` return) are enforced there, not by this
signature (ADR-0013 §4).

```ts
// src/middlewares/auth.ts
import { jwtAuth } from 'katajs/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({ secret: JWT_SECRET, claims: UserClaimsSchema }),
})
```

### `JwtAuthOptions`

```ts
type JwtAuthOptions<S extends z.ZodTypeAny, R extends Registry = Registry> = {
  secret: string
  claims: S
  slot?: string
  alg?: JwtAlgorithm
  issuer?: string
  audience?: string
  header?: string
  resolve?: (claims: z.infer<S>, c: MiddlewareContext<R>) => Promise<unknown> | unknown
}
```

| Field | Type | Effect |
| --- | --- | --- |
| `secret` | `string` | Verification key (required). |
| `claims` | `S extends z.ZodTypeAny` | Schema the payload must satisfy. Its `z.infer` becomes the slot value, unless `resolve` maps it further (required). |
| `slot?` | `string` | Scoped slot to fill. Default `'currentUser'`. |
| `alg?` | `JwtAlgorithm` | Expected algorithm. Default `'HS256'`. |
| `issuer?` | `string` | When set, require this `iss` claim. |
| `audience?` | `string` | When set, require this `aud` claim. |
| `header?` | `string` | Request header to read the bearer token from. Default `'authorization'`. |
| `resolve?` | `(claims, c) => Promise<unknown> \| unknown` | Map the validated claims to the value written into the slot. See below. |

### The `resolve` hook

Without `resolve`, the slot holds the **Zod-validated claims** verbatim. With
`resolve`, it holds whatever you return — and the slot's type is that value, not
`z.infer<S>`. It runs after claims validation, receives the validated claims and
the middleware context, and may be `async`:

```ts
handler: jwtAuth({
  secret: JWT_SECRET,
  claims: IdClaimsSchema, // e.g. { sub: z.string() }
  resolve: async (claims, c) => c.get('db').users.findById(claims.sub),
})
```

Returning `null` or `undefined` means "valid token, but no such user" and
renders a **401** — distinct from a 403, which is an authorization decision a
guard makes.

### Authentication failures (401)

Every failure short-circuits the chain with the unified error envelope as a
**401**; the handler never runs.

| Situation | `error` | `message` |
| --- | --- | --- |
| missing / malformed `Authorization` header | `unauthorized` | `Missing bearer token` |
| bad signature, wrong alg, `iss` / `aud` / `nbf` mismatch, expired | `unauthorized` | `Invalid or expired token` |
| payload fails `claims` | `unauthorized` | `Token claims did not match` (with `issues.claims`) |
| `resolve` returns `null` / `undefined` | `unauthorized` | `No such user` |

Invalid and expired collapse to one message on purpose — no validity oracle.

## Guards

A guard is an **authorization** layer over the slot `jwtAuth` filled. It reads an
already-provided slot and rejects with a **403** envelope when its predicate says
no; otherwise it calls `next()`. Each guard returns the **handler only** and
provides nothing, so wrap it with `defineMiddleware({ provides: [] as const,
handler })` and place it **after** the auth middleware in the route's `use:`
array.

### `guard`

```ts
guard<R extends Registry, C = unknown>(
  options: GuardOptions<R, C>,
): Middleware<R>['handler']
```

The general form. `C` is your assertion of the slot value's type.

```ts
type GuardOptions<R extends Registry, C = unknown> = {
  slot?: string
  authorize: (claims: C, c: MiddlewareContext<R>) => boolean | Promise<boolean>
  code?: string
  message?: string
}
```

| Field | Type | Effect |
| --- | --- | --- |
| `authorize` | `(claims, c) => boolean \| Promise<boolean>` | Predicate over the slot value. Return `false` to reject with 403 (required). |
| `slot?` | `string` | Slot the guard reads. Default `'currentUser'`. |
| `code?` | `string` | 403 envelope `error` code. Default `'forbidden'`. |
| `message?` | `string` | 403 envelope message. Default `'Insufficient permissions'`. |

```ts
import { guard } from 'katajs/jwt'

const requireOwner = defineMiddleware({
  provides: [] as const,
  handler: guard<AppRegistry, User>({
    authorize: (user, c) => user.id === c.raw.req.param('id'),
    code: 'forbidden',
    message: 'Not your resource',
  }),
})
```

### `requireRole`

```ts
requireRole<R extends Registry>(
  role: string | readonly string[],
  options?: { slot?: string },
): Middleware<R>['handler']
```

Sugar over `guard`. Allow only when the slot value's `role` is (one of) `role`.
Reads the default `currentUser` slot (override via `options.slot`) and rejects
with the default 403 `forbidden` envelope.

```ts
use: [requireUser, requireRole('admin')]
use: [requireUser, requireRole(['admin', 'editor'])]
```

### `requireClaim`

```ts
requireClaim<R extends Registry, C extends Record<string, unknown> = Record<string, unknown>>(
  key: string,
  expected: unknown | ((value: unknown) => boolean),
  options?: { slot?: string },
): Middleware<R>['handler']
```

Sugar over `guard`. Allow only when the slot value's claim at `key` matches
`expected` — by strict equality, or by predicate when `expected` is a function.
Reads the default `currentUser` slot (override via `options.slot`).

```ts
// strict equality
handler: requireClaim('email_verified', true)

// predicate
handler: requireClaim('plan', (v) => v === 'pro' || v === 'team')
```

## Exported types

| Type | Shape |
| --- | --- |
| `JwtAlgorithm` | `'HS256' \| 'HS384' \| 'HS512' \| 'RS256' \| 'RS384' \| 'RS512' \| 'PS256' \| 'PS384' \| 'PS512' \| 'ES256' \| 'ES384' \| 'ES512' \| 'EdDSA'`. |
| `SignOptions` | Options for `signJwt`. |
| `VerifyOptions<S>` | Options for `verifyJwt`. |
| `JwtErrorCode` | `'invalid_token' \| 'expired' \| 'claims_mismatch'`. |
| `JwtError` | A verify failure: `{ code, message, issues? }`. |
| `JwtVerifyResult<T>` | The `verifyJwt` result: `{ ok: true, claims }` or `{ ok: false, error }`. |
| `JwtAuthOptions<S, R>` | Options for `jwtAuth`. |
| `GuardOptions<R, C>` | Options for `guard`. |

`Registry`, `Middleware`, `MiddlewareContext`, and `FieldIssue` are core types
re-used in these signatures; they are exported from `kata`, not `kata/jwt`.

::: info You own the login flow
`kata/jwt` gives you signing, verification, the auth middleware, and guards.
Password hashing, the user store, the login route, refresh tokens, and remote
JWKS / OIDC sit beyond this seam — they are yours. See the
[Authentication cookbook](/cookbook/auth) and [ADR-0013](/adr/0013-jwt-delivery).
:::

## See also

- [JWT auth](/guide/jwt) — the narrative guide this page complements.
- [Authentication cookbook](/cookbook/auth) — the end-to-end login walkthrough.
- [defineMiddleware](/reference/define-middleware) — `provides`, the handler, short-circuiting.
- [Errors](/guide/errors) — the unified error envelope guards and `jwtAuth` render.
- [API reference](/reference/) — every public export across `kata`, `kata/jwt`, and `kata/node`.
- [ADR-0013](/adr/0013-jwt-delivery) — why `hono/jwt`, why a subpath, the BYO boundary.
