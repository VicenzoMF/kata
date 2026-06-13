import { createApp } from './context'
import * as users from './modules/users/users.route'

/**
 * The modules tuple. `as const` keeps the element types literal — which is what
 * `createApp`'s `const` type parameter infers anyway — so `KataApp<Modules>` and
 * `typeof app` name the exact same type (proven in client.ts).
 */
const modules = [users] as const

/**
 * `createApp` returns a *parametric* `Hono` (issue #13): its RPC `Schema` is
 * derived from the routes above, so `hc<typeof app>` infers every path, request
 * input (from `input` schemas), and response (from `output` schemas) with zero
 * codegen. The runtime registration loop is untouched — only the return *type*
 * changed (see `packages/kata/src/rpc.ts`).
 *
 * `requestLogging` is off solely to keep this example's test output quiet; flip
 * it on to see per-request logs through the registered `logger` singleton.
 */
export const app = createApp({ modules, requestLogging: false })

/**
 * The public app type a server package exposes for its clients (issue #14). A
 * frontend imports *only this type* and does `hc<AppType>(baseUrl)` — no shared
 * runtime, no codegen. Equivalent to `KataApp<Modules>`.
 */
export type AppType = typeof app

/** The modules tuple type, so consumers can spell `KataApp<Modules>` directly. */
export type Modules = typeof modules
