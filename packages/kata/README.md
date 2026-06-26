# katajs

> A web framework on Hono. Opinionated like NestJS, functional like a script,
> verifiable like a type system.

Static DI, mandatory input/output schemas, and a locked folder layout — see the
[ADRs](https://github.com/VicenzoMF/kata/tree/main/docs/adr) for the full reasoning.

## Install

`hono` and `zod` are peer dependencies — install them alongside `katajs`:

```sh
pnpm add katajs hono zod
```

## Usage

```ts
import { defineContext, singleton } from 'katajs'

const { defineRoute, createApp } = defineContext({
  greeting: singleton('hello'),
})
```

`defineContext` returns the typed factory (`defineMiddleware`, `defineRoute`,
`createApp`). Every route declares `input` and `output` Zod schemas; dependencies
are read through the statically-typed `c.get('key')`.

## Typed RPC client

`createApp` returns a parametric Hono app, so Hono's `hc` client infers paths,
inputs, and responses from your Zod schemas with **no codegen**. Export the app
type (or name it with the exported `KataApp`) and consume it from any client:

```ts
import { hc } from 'hono/client'
import type { AppType } from './server' // export type AppType = typeof app

const client = hc<AppType>('https://api.example.com')
const res = await client.users.$post({ json: { name: 'Ada', email: 'a@b.io' } })
const user = await res.json() // typed from the route's `output` schema
```

See [`examples/hello-client`](https://github.com/VicenzoMF/kata/tree/main/examples/hello-client)
for a runnable, type-checked walkthrough.

The package ships as ESM with bundled type declarations (`dist/index.js` +
`dist/index.d.ts`).
