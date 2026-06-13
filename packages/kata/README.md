# kata

> A web framework on Hono. Opinionated like NestJS, functional like a script,
> verifiable like a type system.

Static DI, mandatory input/output schemas, and a locked folder layout — see the
[ADRs](https://github.com/VicenzoMF/kata/tree/main/docs/adr) for the full reasoning.

## Install

`hono` and `zod` are peer dependencies — install them alongside `kata`:

```sh
pnpm add kata hono zod
```

## Usage

```ts
import { defineContext, singleton } from 'kata'

const { defineRoute, createApp } = defineContext({
  greeting: singleton('hello'),
})
```

`defineContext` returns the typed factory (`defineMiddleware`, `defineRoute`,
`createApp`). Every route declares `input` and `output` Zod schemas; dependencies
are read through the statically-typed `c.get('key')`.

The package ships as ESM with bundled type declarations (`dist/index.js` +
`dist/index.d.ts`).
