import { defineContext, singleton } from 'kata'

/**
 * A logger singleton, registered in the DI context only to make a point: a
 * server-side dependency (ADR-0004) never reaches the wire. The RPC client's
 * Hono `Env` stays `BlankEnv` — proven in client.ts — so `c.get('logger')`
 * works in handlers but is invisible to `hc<AppType>`.
 */
type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[hello-client] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  logger: singleton(logger),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
