declare const SINGLETON_BRAND: unique symbol
declare const SCOPED_BRAND: unique symbol

export type Singleton<T> = {
  readonly [SINGLETON_BRAND]: T
  readonly __value: T
  readonly __kind: 'singleton'
}

export type Scoped<T> = {
  readonly [SCOPED_BRAND]: T
  readonly __kind: 'scoped'
}

export type Slot = Singleton<unknown> | Scoped<unknown>

export type Registry = Readonly<Record<string, Slot>>

export type ResolvedValue<S> =
  S extends Singleton<infer T> ? T : S extends Scoped<infer T> ? T : never

export type SingletonKeys<R extends Registry> = {
  [K in keyof R]: R[K] extends Singleton<unknown> ? K : never
}[keyof R]

export type ScopedKeys<R extends Registry> = {
  [K in keyof R]: R[K] extends Scoped<unknown> ? K : never
}[keyof R]
