import { defineContext, scoped, singleton } from 'kata'
import type { Store, Transaction } from './store'
import { createStore } from './store'

/** Identity attached to a request by the auth middleware (scoped slot). */
export type CurrentUser = {
  id: string
}

type Logger = {
  info: (msg: string, extra?: object) => void
}

const logger: Logger = {
  info: (msg, extra) => console.log(`[shop] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  // Shared singletons.
  store: singleton<Store>(createStore()),
  logger: singleton(logger),
  // Request-scoped slots (ADR-0004): populated by middleware, never global state.
  currentUser: scoped<CurrentUser>(),
  tx: scoped<Transaction>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
