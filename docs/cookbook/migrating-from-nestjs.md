# Recipe: Migrating from NestJS to Kata

**Problem:** you know NestJS — controllers, providers, modules, guards, pipes,
DTOs — and you want the equivalent in Kata without re-learning a framework from
scratch.

**Pattern:** every NestJS building block maps to a plain function or plain object
in Kata. There are no classes and no decorators ([ADR-0002](../adr/0002-no-classes-no-decorators.md)):
a controller becomes a set of `defineRoute` calls, a provider becomes a slot in
`defineContext`, a guard or interceptor becomes a `defineMiddleware`, and a
class-validator DTO becomes a Zod schema. This guide is the side-by-side.

Every Kata snippet below is grounded in the real framework surface
([`packages/kata/src/index.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/index.ts)) and the
runnable [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello) app. If a snippet shows an API,
that API exists today.

> **Before you start.** Kata is pre-release and not yet on npm. The fastest path
> is to clone the repo and copy [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello) into
> your `src/` — the [README quickstart](https://github.com/VicenzoMF/kata/blob/main/README.md#quickstart) walks the
> same six files this guide migrates to.

## The mental-model shift

NestJS resolves your app at runtime: an IoC container reads constructor metadata
(via `reflect-metadata`), instantiates providers, and wires controllers. Kata
resolves it at **edit time**: dependencies are one static object, routes are
plain values, and there is no container, no reflection, and no decorator
metadata. Kata's thesis is that this makes the code mechanically verifiable — a
route is `defineRoute({...})` and nothing else, so a fast lint hook (and a human,
and an agent) can check it by shape ([ADR-0002](../adr/0002-no-classes-no-decorators.md)).

| | NestJS | Kata |
|---|---|---|
| Building block | class + decorator | function + plain object |
| Dependency injection | runtime IoC container | one static `defineContext` registry |
| Wiring | `reflect-metadata` at boot | imports + `c.get('key')` |
| Per-route contract | optional `ValidationPipe` / DTOs | mandatory `input` / `output` Zod schemas |
| Code layout | `@Module` graph | locked `modules/<domain>/` folders |

## Cheat sheet

| NestJS | Kata | Reference |
|---|---|---|
| `@Controller()` class with `@Get()` / `@Post()` methods | one `defineRoute({ method, path, handler })` per endpoint | [§ Controllers](#controllers--routes) |
| `@Body()` / `@Param()` / `@Query()` / `@Headers()` | `c.input.body` / `c.input.params` / `c.input.query` / `c.input.headers` | [§ Controllers](#controllers--routes) |
| DTO class + `class-validator` + `ValidationPipe` | Zod schema in `<domain>.schema.ts`, declared as the route's `input` | [§ DTOs & pipes](#dtos-pipes--validation--zod-schemas) |
| Parse/transform pipe (`ParseIntPipe`, custom) | Zod coercion / transform (`z.coerce.number()`, `.transform()`) | [§ DTOs & pipes](#dtos-pipes--validation--zod-schemas) |
| `@Injectable()` provider (`useClass` / `useValue` / `useFactory`) | `singleton(value)` in `defineContext` | [§ Providers](#providers--dependency-injection) |
| Constructor injection | `c.get('key')` (typed; resolved synchronously) | [§ Providers](#providers--dependency-injection) |
| Request-scoped provider (`Scope.REQUEST`) | `scoped<T>()` slot + a middleware that `c.set`s it | [§ Request scope](#request-scoped-providers) |
| Guard (`CanActivate`) + `@UseGuards()` | `defineMiddleware` returning `c.error(...)` (deny) or `next()` (allow), listed in `use:` | [§ Guards](#guards-interceptors--middleware) |
| Interceptor (`NestInterceptor`) | `defineMiddleware` wrapping `await next()` | [§ Guards](#guards-interceptors--middleware) |
| Exception filter (`@Catch`) + `HttpException` | `c.error(code, message, { status })` + the global error boundary | [§ Errors](#exception-filters--cerror) |
| `@Module({ providers, controllers, imports })` | `modules/<domain>/` folder + `createApp({ modules: [...] })` | [§ Modules](#modules--the-folder-layout) |
| `NestFactory.create(AppModule)` + `app.listen()` | `createApp({ modules })` + `serve({ fetch: app.fetch, port })` | [§ Bootstrap](#bootstrap) |
| `app.useGlobalGuards` / `useGlobalPipes` / `useGlobalFilters` | per-route `use:` + always-on validation; truly global → `createApp({ middlewares })` ([ADR-0012](../adr/0012-app-level-middleware.md)), or Hono `app.use('*', ...)` | [§ Bootstrap](#bootstrap) |

## The shared context file

Everything below imports from one file. Kata centralises dependency injection in
a single `defineContext({...})` call ([ADR-0004](../adr/0004-di-via-scoped-slots.md)) —
the analogue of your root `AppModule`'s `providers` array, but flat and global
rather than per-module. `defineContext` returns the `defineRoute`,
`defineMiddleware`, and `createApp` helpers bound to that registry; re-export
them so the rest of the app imports from `./context`, never from `katajs`
directly. This mirrors [`examples/hello/src/context.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/context.ts):

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[app] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  // singletons — one instance for the whole process (≈ a default-scoped provider)
  db: singleton(makeDb(process.env)),
  logger: singleton(logger),
  // scoped slots — one value per request, set by a middleware (≈ Scope.REQUEST)
  currentUser: scoped<User>(),
})

// Bind the helpers to this registry, then import them everywhere else.
export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

## Controllers → routes

A NestJS controller is a class whose methods are decorated with the HTTP verb and
path; parameters are pulled in with `@Body()`, `@Param()`, and friends.

```ts
// NestJS
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  getUser(@Param('id') id: string) {
    return this.users.findOne(id)
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)
  }
}
```

In Kata there is no controller class. Each endpoint is its own `defineRoute`
value, exported by name from `<domain>.route.ts`. The verb and path are fields;
inputs arrive pre-validated on `c.input`, typed from the route's `input` schemas.
This mirrors [`examples/hello/src/modules/users/users.route.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.route.ts):

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'

import { CreateUserBodySchema, UserIdParamSchema, UserSchema } from './users.schema'
import { createUser, findUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id', // Hono path syntax — `:id`, not `{id}`
  input: { params: UserIdParamSchema },
  output: UserSchema,
  handler: async (c) => {
    const user = await findUser(c.get('db'), c.input.params.id)
    if (!user) return c.error('not_found', 'No user with that id', { status: 404 })
    return user // a plain value is validated against `output`, then sent as 200
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.get('db'), c.input.body),
})
```

Mapping the parameter decorators:

| NestJS | Kata | Requires |
|---|---|---|
| `@Param('id') id: string` | `c.input.params.id` | `input: { params: SomeSchema }` |
| `@Query('q') q: string` | `c.input.query.q` | `input: { query: SomeSchema }` |
| `@Body() dto: CreateUserDto` | `c.input.body` | `input: { body: SomeSchema }` |
| `@Headers('authorization')` | `c.input.headers.authorization` | `input: { headers: SomeSchema }` |

`c.input` is fully typed from the schemas — there is no per-parameter decorator
and no `@Req()`/`@Res()` by default (the raw Hono context is available as
`c.raw` if you need it). Every route **must** declare both `input` and `output`
([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)); a route that reads
nothing still writes `input: {}` explicitly.

## DTOs, pipes & validation → Zod schemas

A NestJS DTO is a class annotated with `class-validator` decorators, validated by
a (usually global) `ValidationPipe`:

```ts
// NestJS
export class CreateUserDto {
  @IsString()
  @MinLength(1)
  name: string

  @IsEmail()
  email: string
}
```

In Kata the DTO **is** the schema. Zod schemas live in `<domain>.schema.ts`,
never inline in the route ([ADR-0005](../adr/0005-dtos-in-separate-schema-file.md)),
and the `z.infer` type lives beside them so one import pulls both the runtime
validator and the compile-time type. This mirrors
[`examples/hello/src/modules/users/users.schema.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.schema.ts):

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

// Params get their own schema too — never inline in the route (ADR-0005).
export const UserIdParamSchema = z.object({ id: z.string() })

export type User = z.infer<typeof UserSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

Common validators translate directly:

| class-validator | Zod |
|---|---|
| `@IsString()` | `z.string()` |
| `@IsEmail()` | `z.string().email()` |
| `@MinLength(1)` / `@Min(1)` | `.min(1)` / `.gte(1)` |
| `@IsOptional()` | `.optional()` |
| `@IsInt()` | `z.number().int()` |
| `@IsEnum(Role)` | `z.enum(['admin', 'user'])` |
| `@ValidateNested()` + nested DTO | a nested `z.object({ ... })` |
| `@Type(() => Number)` on a query param (`ParseIntPipe`) | `z.coerce.number()` |
| a custom transform pipe | `.transform((v) => ...)` on the schema |

Two differences worth internalising:

- **Validation is mandatory and per-route**, not a global pipe you opt into. You
  cannot forget it — omitting `input` or `output` is a TypeScript error
  ([ADR-0003](../adr/0003-mandatory-input-output-schemas.md)).
- **The response is validated too.** After your handler returns a value, Kata
  checks it against `output` and answers `500 internal_output_shape_mismatch` if
  it drifts — there is no NestJS equivalent. See [errors.md](./errors.md).

When input fails, Kata never calls your handler; it returns the `422`
`validation_failed` envelope with issues keyed by section (`params` / `query` /
`body` / `headers`). The exact shape is documented in [errors.md](./errors.md)
and asserted in [`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl).

## Providers → dependency injection

A NestJS provider is an `@Injectable()` class wired through a module and injected
via the constructor; the IoC container builds the graph at boot.

```ts
// NestJS
@Injectable()
export class UsersService {
  constructor(private readonly db: DbClient) {}
  findOne(id: string) {
    return this.db.user.findUnique({ where: { id } })
  }
}

@Module({
  providers: [UsersService, { provide: DbClient, useFactory: () => makeDb() }],
  controllers: [UsersController],
})
export class UsersModule {}
```

Kata has no container and no constructor injection. A long-lived dependency is a
`singleton` slot in the central `defineContext`, and the "service" is a set of
**pure functions** that take the dependency as an argument — trivial to unit-test
without booting a server. This is the [database.md](./database.md) pattern:

```ts
// src/db.ts — model the client as a type + factory (no class; ADR-0002)
import type { User } from './modules/users/users.schema'

export type Db = {
  findUser: (id: string) => Promise<User | null>
  insertUser: (user: User) => Promise<void>
}

export function makeDb(env: NodeJS.ProcessEnv): Db {
  // Swap the in-memory store for your real driver (Prisma, Drizzle, pg, …).
  void env
  const store = new Map<string, User>()
  return {
    findUser: async (id) => store.get(id) ?? null,
    insertUser: async (user) => {
      store.set(user.id, user)
    },
  }
}
```

```ts
// src/modules/users/users.service.ts — pure functions, no framework import
import type { Db } from '../../db'
import type { CreateUserBody, User } from './users.schema'

export async function findUser(db: Db, id: string): Promise<User | null> {
  return db.findUser(id)
}

export async function createUser(db: Db, input: CreateUserBody): Promise<User> {
  const user: User = { id: crypto.randomUUID(), ...input }
  await db.insertUser(user)
  return user
}
```

Register the client once (`db: singleton(makeDb(process.env))`, shown in
[the shared context](#the-shared-context-file)) and read it in a handler with
`c.get('db')`. How the NestJS provider recipes map:

| NestJS provider | Kata |
|---|---|
| `useValue: x` | `singleton(x)` |
| `useFactory: () => makeX(env)` (sync) | `singleton(makeX(env))` — runs once at startup |
| `useClass: XService` | a `makeX()` factory + `type X`, registered as `singleton(makeX())` |
| `@Inject(TOKEN)` constructor param | `c.get('token')` — a string key in `defineContext` |

`c.get('db')` is monomorphic — always `Db`, never `Promise<Db>` or
`Db | undefined` — and it **only compiles for keys you registered**
([ADR-0004](../adr/0004-di-via-scoped-slots.md)). There are no provider tokens,
no `@Optional()`, and no circular-dependency resolver: the registry is one flat
object you can read top to bottom.

> **Async providers.** Nest's `useFactory` can be `async`; Kata's `singleton`
> takes a ready value. For setup that must `await` (e.g. connecting a pool before
> the first request), do it in `main.ts` before `createApp`, or connect lazily
> inside the client. There is no async-provider phase.

## Request-scoped providers

A NestJS `Scope.REQUEST` provider is re-instantiated per request by the
container. In Kata, request state is a `scoped<T>()` slot **declared** up front
and **populated** by a middleware — Pattern C in
[ADR-0004](../adr/0004-di-via-scoped-slots.md). The slot is `currentUser` in
[the shared context](#the-shared-context-file); the middleware fills it (see the
next section). A handler then reads it synchronously with `c.get('currentUser')`,
exactly like a singleton.

The one rule with no NestJS equivalent: the providing middleware must be in the
route's `use:` chain. Reading a scoped slot that no middleware set throws at
runtime (and is caught by the `kata/scoped-slot-not-provided` lint rule). Full
treatment in [auth.md](./auth.md).

## Guards, interceptors → middleware

NestJS has three distinct cross-cutting mechanisms — guards, interceptors, and
middleware. Kata unifies all of them into one: `defineMiddleware`. A middleware
receives the context `c` and `next`; it can run logic before `await next()`,
after it, or short-circuit by returning a `Response` instead of calling `next()`.

### Guard → a middleware that allows or denies

A NestJS guard returns a boolean (or throws) to allow/deny:

```ts
// NestJS
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    return Boolean(req.headers['x-user-id'])
  }
}
// usage: @UseGuards(AuthGuard)
```

In Kata, "deny" means return a `Response`; "allow" means call `next()`. A guard
that also makes the authenticated user available declares the scoped slot it
`provides`. The shim below stays minimal to show the mechanism — `c.header`,
`c.set`, `provides`; the real
[`examples/hello`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/middlewares/auth.ts) middleware
verifies a JWT with `jwtAuth` instead (see [auth.md](./auth.md)):

```ts
// a header-only shim — see auth.md for the real jwtAuth version
import { defineMiddleware } from '../context'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const, // the scoped slots this middleware fills
  handler: async (c, next) => {
    const userId = c.header('x-user-id') // c.header is middleware-only
    if (!userId) return c.error('unauthorized', 'Missing x-user-id header', { status: 401 })

    c.set('currentUser', { id: userId, name: `User-${userId}`, email: `user-${userId}@example.test` })
    await next() // run the rest of the chain + the handler
  },
})
```

A route opts in via `use:`, and order matters — middlewares run left to right, so
an authorization guard that reads `currentUser` must come **after** the one that
provides it (the `use:` order is the contract):

```ts
// src/modules/users/users.route.ts
export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser], // ≈ @UseGuards(AuthGuard)
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'), // typed User, set by the middleware
})
```

A role guard that depends on the user provides nothing and reads the slot the
earlier middleware set — see the [authorization recipe](./auth.md#authorization-a-role-guard-that-depends-on-the-user).

### Interceptor → a middleware around `next()`

A NestJS interceptor wraps the handler to add timing, logging, or response
shaping. The before/after halves become code on either side of `await next()`:

```ts
// src/middlewares/timing.ts
import { defineMiddleware } from '../context'

export const timing = defineMiddleware({
  provides: [] as const,
  handler: async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    c.get('logger').info(`${c.raw.req.method} ${c.raw.req.path} — ${ms}ms`)
  },
})
```

Two honest limits versus a NestJS interceptor:

- **A middleware cannot read or rewrite the handler's response body.** The
  handler's return value is not handed back to the middleware after `next()`, so
  the classic "wrap every response in `{ data: ... }`" interceptor has no direct
  equivalent — put that shape in the handler and the `output` schema instead.
- **Response headers** *can* be set through the Hono context and survive into the
  final response — that is exactly how the built-in `cors()` and `secureHeaders()`
  middlewares work (verified in [`echo.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/echo/echo.hurl)).
  Reach for those built-ins rather than hand-rolling header logic — and apply
  cross-cutting hardening **once** through the global `middlewares` chain
  ([ADR-0012](../adr/0012-app-level-middleware.md)) rather than per route:

```ts
// src/main.ts — hardening declared once, app-wide (ADR-0012)
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp } from './context'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

export const app = createApp({
  modules: [users, echo],
  // Runs before every route's `use:` — no per-route copy-paste.
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

  The global chain composes with a route's own as `[...middlewares, ...use]`, so a
  route that needs middleware for itself alone still lists it in `use:`.
  [`examples/hello`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/main.ts) applies exactly this trio
  app-wide.

## Exception filters → `c.error`

NestJS centralises error mapping in exception filters and an `HttpException`
hierarchy: you `throw new NotFoundException()` and a filter renders the body.

Kata has no exception-type→response mapping. For an **expected** error, return
`c.error(code, message, { status })` directly from the handler (or middleware).
It builds the one unified envelope — `{ error, message, issues? }` — that every
4xx/5xx Kata produces ([ADR-0008](../adr/0008-unified-error-response-envelope.md)):

```ts
// NestJS:  throw new NotFoundException('No user with that id')
// Kata:
if (!user) return c.error('not_found', 'No user with that id', { status: 404 })
```

`c.error` is available on both the route and middleware contexts. `status`
defaults to `400`, and you can attach structured field errors via
`{ issues }`. Returning a `Response` (which `c.error` is) short-circuits the
route — it is sent verbatim and is **not** checked against `output`.

For an **unexpected** error, a global error boundary catches any throw that
escapes a handler or middleware and serialises it as a generic
`500 internal_error` envelope — never Hono's default text/HTML page, and never
leaking the underlying message (ADR-0008, Alternative D). This is exercised by
the `/boom` route in [`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl).
Because a throw becomes an opaque 500, **prefer `c.error` for anything the client
should understand** — reserve throwing for genuine bugs.

For per-status contracts, `output` can be a status→schema map
(`{ 200: UserSchema, 404: ErrorBodySchema }`,
[ADR-0011](../adr/0011-multi-status-output-schemas.md)): a plain return is the 200
body, and a `c.json(body, status)` / `c.error(...)` whose status is declared is
validated against that status's schema (Kata ships `ErrorBodySchema` for the
unified envelope). A single `output` schema still works unchanged — its error
`Response`s bypass validation.

## Modules → the folder layout

A NestJS `@Module` is a dependency-injection boundary: it lists `providers`,
`controllers`, `imports`, and `exports`, and the container scopes provider
visibility to it.

A Kata "module" is **not** an injection scope. It is a folder under
`src/modules/<domain>/` holding the route, service, schema, test, and Hurl files
for one domain ([AGENTS.md](https://github.com/VicenzoMF/kata/blob/main/AGENTS.md)), plus its registration in
`createApp`. All dependency injection is the single, global `defineContext` — so
there is no per-module `providers` list, no `exports`, and no `imports` graph to
wire. To "use a provider from another module," you just `c.get('it')`; it is
already in the central registry.

```
src/
├── context.ts                # the whole DI registry (≈ all your modules' providers)
├── main.ts                   # createApp({ modules: [...] })  (≈ AppModule)
├── middlewares/
└── modules/<domain>/
    ├── <domain>.route.ts      # defineRoute calls   (≈ controller)
    ├── <domain>.service.ts    # pure functions      (≈ provider)
    ├── <domain>.schema.ts     # Zod schemas         (≈ DTOs)
    ├── <domain>.test.ts       # unit tests
    └── <domain>.hurl          # API E2E
```

A "module" passed to `createApp` is simply the namespace import of a
`.route.ts` file; Kata registers every route it exports.

## Bootstrap

```ts
// NestJS
const app = await NestFactory.create(AppModule)
app.useGlobalPipes(new ValidationPipe())
await app.listen(3000)
```

```ts
// src/main.ts — mirrors examples/hello
import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users, echo] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

The `NestFactory` globals map cleanly:

- `useGlobalPipes(new ValidationPipe())` → nothing to do; validation is mandatory
  per route already.
- `useGlobalGuards` / `useGlobalInterceptors` / a truly global middleware →
  declare them once in `createApp({ middlewares: [...] })`
  ([ADR-0012](../adr/0012-app-level-middleware.md)): a Kata `Middleware` chain that
  runs before every route's `use:`, sharing the same contract, per-request scoped
  store, and short-circuit semantics. The hardening built-ins live here —
  `middlewares: [cors(), secureHeaders(), bodyLimit()]`.
- An arbitrary third-party Hono middleware (or full CORS preflight `OPTIONS`
  handling) → `createApp` still returns a plain Hono app, so `app.use('*', ...)`
  works too, and remains the recommended spot for app-wide CORS preflight (see the
  note in [`packages/kata/src/middlewares/cors.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/middlewares/cors.ts)).

## What Kata intentionally does NOT have

Being explicit, so you stop looking for these:

| You'll miss from NestJS | Why it's gone | Do this instead |
|---|---|---|
| Classes & decorators (`@Controller`, `@Injectable`, `@Module`, `@Get`, `@Body`) | Hidden control flow that can't be grepped or mechanically verified ([ADR-0002](../adr/0002-no-classes-no-decorators.md)) | Functions + plain objects: `defineRoute`, `defineMiddleware`, `defineContext` |
| Runtime IoC container & `reflect-metadata` | Cold-start cost; the verifier loses its "one grep answers the question" property ([ADR-0004](../adr/0004-di-via-scoped-slots.md)) | One static `defineContext`; `c.get('key')` is a typed lookup |
| Per-module providers / `imports` / `exports` | Modules are folders, not DI scopes | One flat, global registry — everything is in `defineContext` |
| Injection scopes beyond singleton & request (`Scope.TRANSIENT`) | Two predictable lifetimes keep `c.get` monomorphic | `singleton` (process) or `scoped` (request, set by a middleware) |
| Async providers & lifecycle hooks (`OnModuleInit`, `OnApplicationShutdown`) | No container to drive a lifecycle | Eager `singleton` factories at startup; teardown via `gracefulShutdown` (`katajs/node`) in `main.ts` ([ADR-0014](../adr/0014-lifecycle-shutdown.md), [database.md](./database.md#closing-the-pool-on-shutdown)) |
| Interceptors that transform the response body / RxJS | The handler's return value isn't exposed to middleware | Shape the response in the handler + `output`; use middleware for before/after work and headers |
| Exception filters & the `HttpException` hierarchy | No exception-type→response mapping layer | `c.error(code, message, { status })`; uncaught throws → generic 500 ([ADR-0008](../adr/0008-unified-error-response-envelope.md)) |
| Pipes as a separate layer (`ValidationPipe`, custom pipes) | Validation is mandatory per route, not opt-in | The route's `input` Zod schemas; `z.coerce` / `.transform()` for coercion |
| `@nestjs/swagger` auto OpenAPI | A deliberate non-goal — Kata doesn't own your docs pipeline, not a roadmap gap ([non-goals.md](./non-goals.md)) | Routes already hold Zod `input` / `output` schemas; feed them to a generator (`@asteasolutions/zod-to-openapi`, `@hono/zod-openapi`) and serve it as a route or via `app.use` |
| `Test.createTestingModule()` | Services are pure functions, not container-managed | Call the function with a hand-rolled fake dependency ([database.md](./database.md#4-test-the-service-with-a-fake-client)) |
| Multiple response shapes per route | Per-status output schemas ([ADR-0011](../adr/0011-multi-status-output-schemas.md)) | `output: { 200: UserSchema, 404: ErrorBodySchema }` — typed for `hc` and validated at runtime |

The throughline: Kata trades NestJS's runtime flexibility for **static
verifiability**. Every constraint above exists so a route, its dependencies, and
its contract are inspectable by shape — by a human, by an agent, and by the
`kata verify` harness.

## Gotchas for NestJS refugees

- **`c.set` and `c.header` are middleware-only.** The route handler context has
  `c.get`, `c.input`, `c.json`, `c.error`, and `c.raw` — handlers consume scoped
  slots, they don't fill them.
- **A scoped read needs a provider in `use:`.** `c.get('currentUser')` throws at
  runtime if no middleware in the route's chain set it — there is no container to
  auto-instantiate it ([auth.md](./auth.md#gotchas)).
- **Middleware order is the contract.** Auth before the role guard, every time —
  left to right.
- **Return value vs. `Response`.** Returning a plain value validates it against
  `output` and sends `200`; returning `c.error(...)` / `c.json(...)` sends it
  verbatim with your status, unvalidated.
- **Prefer `c.error` over `throw`.** A thrown error becomes an opaque
  `500 internal_error` (no detail leaked); only genuine bugs should throw.
- **Singletons are eager.** `makeDb(process.env)` runs when `context.ts` is first
  imported, not on first `c.get`. Do startup there; keep request logic out of the
  factory ([database.md](./database.md#gotchas)).
- **There is one `defineContext`.** Don't look for per-module providers — the
  whole registry is one object.

## See also

- [README quickstart](https://github.com/VicenzoMF/kata/blob/main/README.md#quickstart) — the same app in six files.
- [Authentication](./auth.md) — scoped slots and role guards in depth.
- [Database access](./database.md) — singletons, pure services, fake-client tests.
- [Errors & validation](./errors.md) — the 422 / 500 envelopes in detail.
- ADRs: [0002 (no classes/decorators)](../adr/0002-no-classes-no-decorators.md),
  [0003 (mandatory schemas)](../adr/0003-mandatory-input-output-schemas.md),
  [0004 (DI via slots)](../adr/0004-di-via-scoped-slots.md),
  [0005 (DTOs in schema files)](../adr/0005-dtos-in-separate-schema-file.md),
  [0008 (error envelope)](../adr/0008-unified-error-response-envelope.md).
- [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello) — the runnable reference this guide tracks.
