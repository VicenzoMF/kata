---
layout: home

hero:
  name: Kata
  text: Disciplined web APIs on Hono.
  tagline: Opinionated like NestJS, functional like a script, verifiable like a type system — built so AI agents and humans both produce correct code on the first try.
  image:
    light: /enso.svg
    dark: /enso-dark.svg
    alt: Kata — an ensō sealed with a cinnabar hanko
  actions:
    - theme: brand
      text: Get started
      link: /guide/what-is-kata
    - theme: alt
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/VicenzoMF/kata

features:
  - title: Static DI
    details: Every dependency is declared once in defineContext. c.get('key') only compiles for keys you registered — your dependencies are statically enumerable, not string-keyed lookups that escape the type system.
  - title: Mandatory schemas
    details: Every route declares input and output Zod schemas. Lint fails if either is missing; input is validated before your handler, output after it. The wrong shape never reaches the client.
  - title: Locked layout
    details: "modules/&lt;domain&gt;/&lt;domain&gt;.{route,service,schema,hurl,test}.ts. No free-floating handlers — every route, service, schema, and test is findable by glob."
  - title: Harness-native
    details: kata verify runs in a sub-100ms PostToolUse hook and returns structured ERROR/WHY/FIX feedback, so agents self-correct on the next turn. The constraints are the moat.
---

## Why another framework

|                                          |  Nest  | Elysia | Hono + Zod template |  Kata  |
| ---------------------------------------- | :----: | :----: | :-----------------: | :----: |
| Functional only                          |   ❌   |   ✅   |         ✅          |   ✅   |
| Runs on Hono (Node · Bun · Deno · Edge)  |   ❌   |   ❌   |         ✅          |   ✅   |
| Mandatory schemas (lint-enforced)        |   ❌   |   ⚠️   |         ❌          |   ✅   |
| Statically enumerable DI                 |   ❌   |   ⚠️   |         ❌          |   ✅   |
| Harness hooks shipped natively           |   ❌   |   ❌   |         ❌          |   ✅   |

[Why Kata, in depth →](/guide/why-kata)

## Six files to a fully-typed API

A module has exactly one place for each concern — schema, service, route — so every
route, DTO, and test is findable by glob, and `kata verify` can check the whole
contract in well under 100&nbsp;ms.

```
src/
├── context.ts                # defineContext({ ... }) — the one DI registry
└── modules/users/
    ├── users.schema.ts        # Zod DTOs
    ├── users.service.ts       # pure functions
    └── users.route.ts         # defineRoute — input + output schemas
```

[Follow the six-file quickstart →](/guide/quickstart)
