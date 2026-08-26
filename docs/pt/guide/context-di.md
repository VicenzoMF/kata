---
title: Context & DI
description: defineContext é o registry único de dependências. Declare singletons e scoped slots, reexporte a factory já vinculada e leia tudo por um c.get monomórfico.
---

# Context & DI

## O problema que isso resolve

Toda route precisa de coisas que ela mesma não construiu — uma conexão de banco,
um logger, o usuário logado no momento. *Injeção de dependência* (DI) é só a
disciplina de declarar essas coisas em um lugar só e deixar o framework entregá-las
a cada route, em vez de cada route importar ou construir as suas por conta própria.

A maioria dos frameworks faz isso com um *container de IoC*: um objeto de runtime
onde você registra classes, e que então as constrói, descobre o que depende do quê
e liga tudo enquanto a app sobe — normalmente movido a decorators e reflection.
**O Kata não tem nada disso.** Sem container, sem decorators, sem reflection. O
registry dele é um object literal simples, e a ligação é verificada pelo sistema de
tipos em tempo de compilação, em vez de resolvida por um container em runtime.

Esse registry é uma única chamada a `defineContext`. É o lugar único que tanto o
sistema de tipos *quanto* o harness de lint leem para responder "quais dependências
existem?". Se algo não estiver declarado ali, o `c.get` correspondente simplesmente
não compila.

```ts
import { defineContext, scoped, singleton } from '@katajs-framework/core'

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
import { defineContext, scoped, singleton } from '@katajs-framework/core'
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
Importe o `defineContext` / `singleton` / `scoped` genéricos de `@katajs-framework/core`; importe
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

Duas propriedades de `c.get` valem ser nomeadas, porque são elas que o tornam agradável
de usar:

- **Ele é síncrono.** `c.get` nunca retorna uma promise — você nunca faz `await` em uma
  dependência. Seja o que for que o slot guarde, você recebe o valor diretamente. (Esta é
  a recompensa concreta de banir factories lazy.)
- **Ele é monomórfico** — ele tem exatamente *um* tipo de retorno por chave, fixado pelo
  registry: `ResolvedValue<R[K]>`. Uma chave singleton retorna precisamente o tipo que você
  registrou; uma chave scoped retorna precisamente o tipo que seu middleware define. Nenhuma
  union para estreitar, nenhum widening, nenhum `| undefined` para se proteger contra.

E ele só passa no type-check para chaves que você realmente declarou. Um typo ou um nome
não declarado é um erro de compilação, e a regra de lint `kata/context-key-not-registered` também o
sinaliza — então você descobre enquanto digita, não em produção.

::: warning Lendo um singleton na inicialização
Os cinco membros retornados são a superfície pública. Fora de um request você não
tem `c`; para alcançar um singleton no boot — por exemplo para logar a porta de
escuta — chame `k.resolve('logger').info(...)`. `resolve` é exclusivo para
singletons — sua própria assinatura de tipo (`SingletonKeys<R>`) rejeita uma
chave scoped em tempo de compilação, então `k.resolve('currentUser')` é um erro
comum do `tsc`, não um achado de lint. A regra `kata/scoped-read-outside-request`
cobre uma superfície diferente — leituras `c.get(...)`, que permanecem tipáveis
para qualquer chave (scoped inclusive) justamente para que a cadeia de
middleware, e não o sistema de tipos, decida se uma leitura é segura. Ela pega
uma leitura scoped `c.get` em qualquer lugar fora de um handler de request,
incluindo um helper independente que recebe `c` como parâmetro — veja
[Pegadinhas no cookbook de auth](/pt/cookbook/auth#pegadinhas) para um exemplo
trabalhado.
:::

## Preencher scoped slots acontece no middleware

Esta é a outra metade da história de scoped-slot acima. Um slot `scoped<T>()`
começa vazio, e a *única* maneira de ele receber um valor é um middleware colocá-lo
lá. O middleware declara quais slots ele `provides` (fornece), e em troca o runtime
lhe entrega um `c.set` que aceita exatamente esses slots:

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

Leia isso como um contrato com dois lados:

- O middleware *promete*, via `provides: ['currentUser'] as const`, que uma vez que ele
  tenha rodado, `currentUser` estará definido. O `as const` é estrutural: sem ele o
  TypeScript alarga o array para `string[]` e o nome literal do slot é perdido.
- Uma rota que lê `c.get('currentUser')` deve listar `requireAuth` em sua cadeia
  `use:`. Essa listagem é o fio real que entrega o valor — ler um slot e
  fornecê-lo são conectados pela cadeia `use:`, nada mais.

O sistema de tipos e o harness mantêm ambos os lados desse contrato honestos:

- `provides` é restrito aos nomes dos seus scoped slots, e `c.set` aceita apenas
  essas chaves com o tipo de valor correto. Definir um singleton, ou um nome que você nunca
  declarou, não compila.
- `kata/scoped-slot-not-provided` reprova uma rota que lê um scoped slot cujo
  middleware fornecedor não está na sua cadeia — `use:` mais o
  `createApp({ middlewares })` do app — ou está, porém *depois* da leitura.
- `kata/middleware-provides-mismatch` reprova um middleware que declara um slot em
  `provides` mas nunca o define de fato.

E se a fiação estiver errada de qualquer forma — o middleware fornecedor nunca rodar — o slot
continua vazio, e o Kata se recusa a mascarar isso com `undefined`. `c.get` lança,
em alto e bom som:

> `kata: scoped slot 'currentUser' read before being set. Did the providing middleware run?`

O lançamento (throw) é deliberado. Um `undefined` silencioso transformaria um erro de fiação em um
crash de referência nula três linhas depois, longe de sua causa; lançar na leitura
aponta direto para o problema. As regras de lint acima existem para pegar o mesmo
erro ainda mais cedo, antes de o código sequer rodar.

Para o contrato completo de middleware — `provides`, a API de contexto,
curto-circuito com um `Response` — veja [Middleware](/pt/guide/middleware).

## Por que enumerabilidade estática importa

Tudo acima compra uma propriedade, e é o motivo de o design ser como é:
**o grafo de dependências inteiro é um único object literal em um único arquivo.** Nada
é computado, registrado dinamicamente ou escondido atrás de uma chamada de factory. Então toda
questão sobre dependências se resume a uma leitura ou a um grep:

- *Quais dependências existem?* → leia `src/context.ts`.
- *Quais routes usam `currentUser`?* → dê grep em `c.get('currentUser')`.

Isso não é apenas uma conveniência para humanos. A história de correção do Kata se apoia em
invariantes multi-arquivo que um checker rápido consegue verificar mecanicamente — toda leitura scoped
tem um middleware que a fornece, toda chave de `c.get` está registrada. Essas verificações são baratas
*só porque* o registry é estaticamente enumerável: o checker dá grep e
faz pattern-match em vez de rodar uma busca de prova em nível de tipos ou dar boot na sua app.
Veja [O harness](/pt/guide/harness).

## AppRegistry

Exporte o tipo do registry sempre que algo precisar *nomear* o seu contexto —
um contrato de middleware, um helper de teste, uma função genérica sobre a app:

```ts
export type AppRegistry = typeof k.registry
```

`AppRegistry` é o `Registry` que seus slots definem: um record readonly de cada chave
para o seu `Singleton<T>` ou `Scoped<T>`. Os `defineRoute`, `defineMiddleware`
e `createApp` vinculados são todos parametrizados sobre ele — então nomeá-lo uma vez
mantém o resto do seu código em sintonia com `context.ts`.

## Próximo

- [Routes & schemas](/pt/guide/routes-schemas) — defina uma route sobre este contexto.
- [Middleware](/pt/guide/middleware) — preencha scoped slots e rode lógica transversal.
- [Referência de create-app](/pt/reference/create-app) — monte modules em uma app.
- [ADR-0004](/adr/0004-di-via-scoped-slots) — por que singletons + scoped slots.
