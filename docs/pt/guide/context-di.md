---
title: Context & DI
description: defineContext é o registry único de dependências. Declare singletons e scoped slots, reexporte a factory já vinculada e leia tudo por um c.get monomórfico.
---

# Context & DI

Kata não tem container de IoC, nem decorators, nem reflection. As dependências
ficam em um único lugar: uma chamada a `defineContext`. Essa chamada é o registry
único que o sistema de tipos e o harness de lint leem. Se uma dependência não for
declarada ali, `c.get` não compila.

```ts
import { defineContext, scoped, singleton } from 'kata'

import type { User } from './modules/users/users.schema'

type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[hello] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  logger: singleton(logger),
  currentUser: scoped<User>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

Este arquivo é `src/context.ts`. Veja [Layout do projeto](/pt/guide/project-layout).

## Dois tipos de slot

`defineContext` recebe um record. Todo valor é um slot construído por um de dois
constructors. Não existe um terceiro tipo.

- `singleton(value)` — um valor para o processo inteiro. O pool, o logger, o
  mailer, o cliente de cache. Você passa o valor já construído; Kata o segura.
- `scoped<T>()` — um valor por request. O usuário atual, o tenant id, uma
  transaction aberta. Você declara apenas o tipo. O valor é preenchido em tempo de
  request por um middleware, nunca na inicialização.

```ts
import { defineContext, scoped, singleton } from 'kata'
import type { Store, Transaction } from './store'
import { createStore } from './store'

export type CurrentUser = { id: string }

export const k = defineContext({
  // Singletons compartilhados.
  store: singleton<Store>(createStore()),
  logger: singleton(logger),
  // Slots request-scoped: preenchidos por middleware, nunca estado global.
  currentUser: scoped<CurrentUser>(),
  tx: scoped<Transaction>(),
})
```

`singleton(value)` infere `T` a partir do que você passa. Quando você precisa de um
tipo mais amplo do que o valor literal — uma interface que um objeto concreto
satisfaz — anote a chamada: `singleton<Store>(createStore())`.

`scoped<T>()` não recebe valor, apenas o parâmetro de tipo. O slot fica vazio até um
middleware defini-lo.

::: info Por que dois tipos e nada mais
Um valor request-scoped que você lê com `c.get` sempre retorna `T` — nunca
`Promise<T>`, nunca `T | undefined`. Kata rejeitou factories lazy exatamente por
isso: um modelo de factory faz `c.get` retornar `T` para algumas chaves e
`Promise<T>` para outras, e força o harness a resolver grafos de chamada em vez de
ler um arquivo. Veja [ADR-0004](/adr/0004-di-via-scoped-slots).
:::

## O que defineContext retorna

`defineContext(registry)` retorna um objeto congelado com quatro membros, cada um já
vinculado ao seu registry:

```ts
const { registry, defineMiddleware, defineRoute, createApp } = defineContext({ /* … */ })
```

- `defineRoute` — define uma route. Seu `c.get` e sua cadeia `use:` conhecem seus
  slots.
- `defineMiddleware` — define um middleware. Seu `provides:` é restrito aos nomes dos
  seus scoped slots.
- `createApp` — monta a app a partir dos modules e dos middlewares de nível de app.
- `registry` — o próprio objeto registry, para derivar `AppRegistry`.

Estas são funções, não helpers genéricos que você reparametriza a cada chamada.
Importe o `defineContext` / `singleton` / `scoped` genéricos de `kata`; importe
`defineRoute` / `defineMiddleware` / `createApp` do seu próprio `context.ts`.

### Reexporte a factory já vinculada

Exporte `defineRoute`, `defineMiddleware` e `createApp` de `context.ts` para que o
resto da app herde os tipos. Cada module então os importa de um único caminho local:

```ts
export const { defineRoute, defineMiddleware, createApp } = k
```

Um arquivo de route:

```ts
import { defineRoute } from '../../context'
```

É isso que faz `c.get('key')` resolver contra o seu registry em todo lugar. Não
reimporte o `defineContext` genérico em um arquivo de route ou middleware — isso
recria uma factory não vinculada e quebra a cadeia.

## Lendo slots: c.get

Dentro de um handler ou de um middleware, leia qualquer slot declarado com
`c.get(key)`:

```ts
import { defineRoute } from '../../context'
import { UserSchema } from './users.schema'
import { requireUser } from '../../middlewares/auth'

export const me = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => {
    const logger = c.get('logger')      // Logger     (singleton)
    const user = c.get('currentUser')   // User       (scoped)
    logger.info('read profile', { id: user.id })
    return user
  },
})
```

`c.get` é monomórfico. Ele retorna o tipo do valor resolvido do slot —
`ResolvedValue<R[K]>` — de forma síncrona, para os dois tipos. Um singleton retorna o
valor que você registrou; um scoped slot retorna o valor que seu middleware definiu.

`c.get('key')` só passa no type-check quando `'key'` é uma chave do seu registry. Um
typo ou um nome não declarado é um erro de compilação, e a regra de lint
`kata/context-key-not-registered` também o sinaliza.

::: warning Lendo o registry na inicialização
Os quatro membros retornados são a superfície pública. Fora de um request você não
tem `c`; para alcançar um singleton no boot — por exemplo para logar a porta de
escuta — leia-o direto do registry: `k.registry.logger.__value.info(...)`. Scoped
slots não têm valor na inicialização por definição, então ler um deles fora de um
handler de request é um erro em tempo de build (`kata/scoped-read-outside-request`).
:::

## Preencher scoped slots acontece no middleware

Um slot `scoped<T>()` começa vazio. Um middleware o preenche. O middleware declara
quais slots fornece; o runtime lhe dá um `c.set` para exatamente esses slots:

```ts
import { defineMiddleware } from '../context'

export const requireAuth = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const userId = c.header('x-user-id')
    if (!userId) return c.error('unauthorized', 'Missing x-user-id header', { status: 401 })

    c.set('currentUser', { id: userId })
    await next()
  },
})
```

`provides` precisa ser `as const` para que os nomes literais dos slots sobrevivam no
tipo. Uma route que lê `c.get('currentUser')` lista `requireAuth` na sua cadeia
`use:` — é assim que o valor chega lá.

O array `provides` é restrito por tipo aos nomes dos seus scoped slots, e `c.set`
aceita apenas essas chaves com o tipo de valor correto. Definir um singleton, ou um
nome que você nunca declarou, não compila. A relação entre uma leitura scoped e um
middleware que a fornece também é uma invariante de lint:
`kata/scoped-slot-not-provided` reprova uma route que lê um scoped slot cujo
middleware não está na sua cadeia `use:`, e `kata/middleware-provides-mismatch`
reprova um middleware que declara um slot que nunca define.

Se o middleware que fornece nunca rodar, o slot nunca é definido. Lê-lo então não é
um `undefined` silencioso — `c.get` lança em runtime:

> `kata: scoped slot 'currentUser' read before being set. Did the providing middleware run?`

As regras de lint acima existem para pegar esse erro de fiação antes do runtime.

Para o contrato completo de middleware — `provides`, a API de contexto,
curto-circuito com um `Response` — veja [Middleware](/pt/guide/middleware).

## Por que enumerabilidade estática importa

O registry inteiro é um único object literal em um único arquivo. Para responder
"quais dependências existem?" você lê `src/context.ts`. Para responder "quais routes
usam `currentUser`?" você dá grep em `c.get('currentUser')`. Sem grafo de factories
para resolver, sem container para rastrear.

Isso é deliberado. A história de correção do Kata se apoia em invariantes multi-arquivo
que um checker rápido consegue verificar mecanicamente — toda leitura scoped tem um
middleware que a fornece, toda chave de `c.get` está registrada. Um único registry
estaticamente enumerável é o que torna essas verificações um grep em vez de uma busca
de prova em nível de tipos. Veja [O harness](/pt/guide/harness).

## AppRegistry

Exporte o tipo do registry para reúso — contratos de middleware, helpers de teste,
qualquer coisa que precise nomear o seu contexto:

```ts
export type AppRegistry = typeof k.registry
```

`AppRegistry` é o `Registry` que seus slots definem: um record readonly de cada chave
para o seu `Singleton<T>` ou `Scoped<T>`. É o tipo sobre o qual os `defineRoute`,
`defineMiddleware` e `createApp` vinculados são parametrizados, então nomeá-lo uma vez
mantém o resto do seu código em sintonia com `context.ts`.

## Próximo

- [Routes & schemas](/pt/guide/routes-schemas) — defina uma route sobre este contexto.
- [Middleware](/pt/guide/middleware) — preencha scoped slots e rode lógica transversal.
- [Referência de create-app](/pt/reference/create-app) — monte modules em uma app.
- [ADR-0004](/adr/0004-di-via-scoped-slots) — por que singletons + scoped slots.
