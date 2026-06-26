---
title: Cookbook
description: Receitas reais de Kata — auth, banco de dados, erros, migração do NestJS e a fronteira BYO.
---

# Cookbook

Receitas do mundo real que não cabem no [quickstart](/pt/guide/quickstart). Cada
receita resolve um problema comum com código pronto para copiar e colar que
espelha os apps de exemplo executáveis — [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello)
(mínimo) e [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop)
(scoped transactions, filtragem de queries).

## Receitas

| Receita | Problema que resolve |
| --- | --- |
| [Autenticação e autorização](/pt/cookbook/auth) | Identificar quem chama e expô-lo aos handlers via um scoped slot, e então autorizar rotas por role ou claim. |
| [Acesso a banco de dados](/pt/cookbook/database) | Compartilhar um cliente de vida longa (db, cache, mailer) entre handlers via um singleton slot, e uma camada de serviço pura que você pode testar de forma unitária. |
| [Erros e validação](/pt/cookbook/errors) | Retornar respostas 4xx corretas e entender os envelopes automáticos 422 / 500 do Kata. |
| [Migrando do NestJS](/pt/cookbook/migrating-from-nestjs) | Mapear cada bloco de construção do NestJS — controllers, providers, guards, pipes, DTOs — para seu equivalente funcional no Kata. |
| [Non-goals e BYO](/pt/cookbook/non-goals) | Veja o que o Kata deliberadamente deixa por sua conta — persistência, rate limiting, métricas, env, paginação — e o padrão idiomático bring-your-own para cada um. |

## Como estas receitas são fundamentadas

Cada trecho é verificado contra a superfície real do framework, não parafraseado
de memória:

- O core API exportado vive em
  [`packages/kata/src/index.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/index.ts);
  os helpers de auth ficam sob [`kata/jwt`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/jwt/index.ts).
- Apps de referência executáveis vivem em
  [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello)
  e [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop).

Se uma receita mostra uma API, essa API existe hoje. Quando uma receita se apoia
em algo planejado mas ainda não entregue, ela é rotulada como _Planejado_ e linka
para a issue de acompanhamento — nunca presuma que uma API planejada já funciona.

## O context compartilhado

Cada receita se constrói sobre um arquivo. O Kata centraliza a injeção de
dependência em uma única chamada `defineContext({...})` (veja [Context e DI](/pt/guide/context-di) e
[ADR-0004](/adr/0004-di-via-scoped-slots)), e os helpers `defineRoute` /
`defineMiddleware` / `createApp` que ela retorna são vinculados a esse context.
A configuração idiomática os re-exporta para que o resto do app importe de
`./context`, nunca de `kata` diretamente:

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

export const k = defineContext({
  // singletons — uma instância para o processo inteiro (veja /pt/cookbook/database)
  db: singleton(makeDb(process.env)),
  // scoped slots — um valor por requisição, definido por um middleware (veja /pt/cookbook/auth)
  currentUser: scoped<User>(),
})

// Vincula os helpers a este context, depois os importa em todos os outros lugares.
export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

```ts
// src/main.ts
import { serve } from '@hono/node-server'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })
```

Cada `module` passado para `createApp` é um arquivo `*.route.ts` importado com
`import * as`; o Kata registra cada route que ele exporta. Veja
[App e createApp](/pt/reference/create-app) para a assinatura completa.

## Convenções que toda receita segue

Estas são impostas em todo o projeto — os trechos as obedecem para que você possa colá-los:

- **Apenas funcional** — sem classes, sem decorators ([ADR-0002](/adr/0002-no-classes-no-decorators)).
- **Apenas named exports** — sem default exports.
- **Sem `any`** — use `unknown` mais narrowing.
- **Schemas vivem em `<domain>.schema.ts`**, nunca inline numa route ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).
- **Toda route declara schemas de `input` e `output`** ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).
- **DI passa por `c.get('key')`**, onde `'key'` precisa estar registrada em
  `defineContext` ([ADR-0004](/adr/0004-di-via-scoped-slots)).

::: tip Leia a reference junto com as receitas
O cookbook é orientado a tarefas. Para a assinatura exaustiva de cada helper, veja a
[reference](/pt/reference/): [`defineContext`](/pt/reference/define-context),
[`defineRoute`](/pt/reference/define-route),
[`defineMiddleware`](/pt/reference/define-middleware),
[`createApp`](/pt/reference/create-app), os
[middlewares embutidos](/pt/reference/middleware) e [`kata/jwt`](/pt/reference/jwt).
:::

## Veja também

- [O que é Kata](/pt/guide/what-is-kata) e [Por que Kata](/pt/guide/why-kata) — a tese por trás das restrições.
- [Layout do projeto](/pt/guide/project-layout) — a estrutura travada `modules/<domain>/` que toda receita pressupõe.
- [Cliente RPC](/pt/guide/rpc-client) — o cliente tipado `hc<AppType>` que estes schemas alimentam de ponta a ponta.
