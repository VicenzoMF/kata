---
title: Middleware & scoped slots
description: Defina middleware, preencha scoped slots, faça short-circuit com uma Response e componha use no nível da rota com cadeias no nível do app.
---

# Middleware & scoped slots

Middleware é como uma requisição é preparada antes do handler rodar. Um middleware
autentica quem chamou, abre uma transação, define um header ou rejeita a
requisição de imediato. No Kata, um middleware faz exatamente um trabalho para o
sistema de tipos: ele **preenche os scoped slots** declarados em `defineContext`.
Um handler lê esses slots com `c.get`; o slot só é sólido se um middleware que o
preenche tiver rodado antes.

Não há sistema de plugins separado nem decorators. Um middleware é um valor
produzido por `defineMiddleware`, e você o compõe sobre uma rota com `use:` ou
sobre o app inteiro com `middlewares:`.

## defineMiddleware

`defineContext` retorna `defineMiddleware`. Importe-o do seu módulo de contexto,
não de `kata`:

```ts
import { defineMiddleware } from '../context'
```

A forma tem dois campos:

```ts
defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    // ...prepara a requisição, preenche slots, opcionalmente faz short-circuit...
    await next()
  },
})
```

- `provides` é a lista de chaves de slot **scoped** que este middleware preenche.
  Escreva-a com `as const` para que as chaves literais permaneçam greppáveis e
  verificáveis pelo lint — a regra `kata/scoped-slot-not-provided` une o
  `provides` da cadeia de uma rota para provar que todo `c.get('slot')` tem um
  provedor.
- `handler` recebe o contexto de middleware `c` e uma função `next`. Ele roda seu
  setup, chama `await next()` para continuar pela cadeia, e pode rodar código
  depois que `next()` retorna. Retornar uma `Response` faz short-circuit (veja
  abaixo).

Um middleware que apenas define um header ou rejeita uma requisição não provê
nada — declare `provides: [] as const`.

### O contexto de middleware

`c` no handler de um middleware é um `MiddlewareContext`, uma superfície menor que
o contexto de rota:

| Membro | Propósito |
| --- | --- |
| `c.get('key')` | Lê qualquer slot registrado — um singleton, ou um scoped slot já preenchido nesta requisição. |
| `c.set('key', value)` | Preenche um slot **scoped**. Só compila para chaves scoped; lança em tempo de execução para uma chave singleton. |
| `c.header('name')` | Lê um header da requisição. Retorna `string \| undefined`. |
| `c.json(value, status?)` | Constrói uma `Response` JSON (status padrão é `200`). Retorne-a para fazer short-circuit. |
| `c.error(code, message, extra?)` | Constrói o envelope de erro unificado. Status padrão é `400`; passe `{ status }` para mudá-lo. |
| `c.requestId` | O id de correlação desta requisição (o `x-request-id` de entrada ou um UUID novo). |
| `c.raw` | O `Context` subjacente do Hono — uma válvula de escape. |

::: warning `c.header` lê, não escreve
Em um middleware, `c.header(name)` é um **getter** de header da requisição. Não há
`c.set` para headers de resposta nem pós-processamento de corpo: o Kata constrói
sua resposta desacoplada de `c.res`, então uma cadeia `use`/global prepara a
requisição e pode fazer short-circuit, mas não pode reescrever o corpo final.
Transformadores de resposta (compressão, ETag) não pertencem aqui. Se você
precisa definir um header de resposta, faça-o em `c.raw` antes de retornar, ou
construa a `Response` você mesmo.
:::

## Preenchendo um scoped slot

Scoped slots são declarados uma vez em `defineContext` e começam cada requisição
vazios. Um middleware preenche um com `c.set`, e o handler o lê com `c.get`.

Dado um contexto com um scoped slot `currentUser`:

```ts
import { defineContext, scoped, singleton } from 'kata'

export type CurrentUser = { id: string }

export const k = defineContext({
  store: singleton(createStore()),
  currentUser: scoped<CurrentUser>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

um middleware de auth mínimo lê um header, rejeita quando ele está ausente e,
caso contrário, preenche o slot:

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

Esta é a auth de brinquedo de `examples/shop` literalmente — um placeholder para
decodificação real de token ou sessão. O handler downstream nunca vê uma
requisição não autenticada: ou o slot está preenchido e `next()` roda, ou o
middleware faz short-circuit com um 401 e o handler é pulado.

::: tip Uma leitura scoped precisa de um provedor
`c.get('currentUser')` só é válido em handlers alcançados por uma cadeia que o
provê. Ler um scoped slot cujo middleware provedor não rodou lança em tempo de
execução (`scoped slot 'currentUser' read before being set`) e é apontado pela
regra de lint `kata/scoped-slot-not-provided`. Singletons não precisam de
provedor — eles vivem durante todo o tempo de vida do processo.
:::

Para autenticação real, `kata/jwt` traz `jwtAuth`, que verifica um bearer token e
preenche um slot `currentUser` para você. O app de exemplo o encapsula para que o
literal `provides` permaneça no call site:

```ts
import { jwtAuth } from 'kata/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

Veja [JWT auth](/pt/guide/jwt) para o contrato completo de `jwtAuth` e os guards de role/claim.

## Short-circuit retornando uma Response

"Short-circuit" significa: encerrar a requisição exatamente aqui, sem rodar mais nada
cadeia abaixo. O tipo de retorno do handler de um middleware é
`Promise<void | Response> | void | Response`, e esse valor de retorno é a chave:

- Retorne `void` (ou simplesmente chame `await next()`) para **continuar**.
- Retorne uma `Response` para **parar** — todo middleware posterior, a validação de input e
  o handler são todos pulados.

Construa essa `Response` com `c.error(...)` ou `c.json(...)`:

```ts
handler: async (c, next) => {
  const token = c.header('authorization')
  if (!token) return c.error('unauthorized', 'Missing Authorization header', { status: 401 })
  // ...verifica, preenche o slot...
  await next()
}
```

Uma resposta de short-circuit ainda flui pelo resto da contabilidade do pipeline:
ela recebe o header `x-request-id` e é logada como qualquer outro desfecho. Por
causa disso, um 401 levantado por um middleware **não** faz parte do contrato
`output` da rota — ele nunca alcança o handler, então você não o declara em
`output:`. Apenas os status que o seu próprio handler retorna pertencem ali.

Lançar também interrompe a requisição, mas significa algo diferente. Um
`c.error(...)` retornado é uma rejeição *esperada* — falha de auth, acesso proibido — um
desfecho para o qual você projetou. Um erro lançado é *inesperado*: o Kata o loga no
servidor e o canaliza para o envelope unificado `500 internal_error`. Então use
`return c.error(...)` para rejeições que você antecipa, e deixe um `throw` sinalizar um
bug genuíno. Veja [Errors](/pt/guide/errors).

## Compondo middleware sobre uma rota

Uma rota lista seu middleware em `use:`, e eles rodam da esquerda para
a direita, todos antes do handler:

```ts
import { ErrorBodySchema } from 'kata'

import { defineRoute } from '../../context'
import { requireAuth } from '../../middlewares/auth'
import { withTransaction } from '../../middlewares/transaction'
import { OrderSchema } from './orders.schema'
import { checkout } from './orders.service'

export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx') // provido por withTransaction
    const user = c.get('currentUser') // provido por requireAuth
    const result = checkout(tx, user.id)
    // ...commit no sucesso, ou c.error(...) para fazer rollback...
    return c.json(result.order, 201)
  },
})
```

`use: [requireAuth, withTransaction]` significa que `requireAuth` roda primeiro e
`withTransaction` em segundo, então no momento em que o handler roda, tanto `currentUser`
quanto `tx` estão preenchidos. Essa ordem do array *é* o contrato: se um slot é derivado de
outro (um `tenantId` computado a partir de `currentUser`), coloque seu provedor mais
cedo na lista.

Uma definição compõe sobre quantas rotas você quiser; não há duplicação por
rota. O único `requireAuth` acima guarda o checkout, a listagem de pedidos e a
busca de um único pedido de uma só vez.

## Middleware no nível do app

Algumas preocupações se aplicam a *toda* rota — CORS, headers seguros, um limite de
tamanho de corpo — e repeti-las no `use:` de cada rota seria ruído. Declare-as uma vez
no app com `createApp({ middlewares })`:

```ts
import { bodyLimit, cors, secureHeaders } from 'kata'

import { createApp } from './context'
import * as orders from './modules/orders/orders.route'
import * as products from './modules/products/products.route'

export const app = createApp({
  modules: [products, orders],
  middlewares: [secureHeaders(), cors(), bodyLimit()], // rodam antes do use: de cada rota
})
```

A cadeia no nível do app roda **antes** do `use:` próprio de cada rota. Então a cadeia
efetiva para qualquer rota é simplesmente as duas concatenadas:

```ts
effective = [...config.middlewares, ...route.use]
```

É o mesmo contrato `Middleware<R>`, o mesmo pipeline de runtime e o mesmo store
scoped por requisição de ponta a ponta. Um middleware global pode fazer short-circuit com uma
`Response` exatamente como um middleware de rota faz, e qualquer scoped slot que ele
`provides:` se torna legível via `c.get` em **todos** os handlers — um `requireAuth`
global torna `currentUser` disponível em todo o app sem uma única rota listá-lo em
`use:`.

A regra de ouro: recorra a `use:` quando uma preocupação é específica de uma rota ou de poucas
rotas, e a `middlewares:` quando ela é genuinamente transversal. Veja
[App-level middleware](/pt/guide/app-middleware) para as regras de ordenação e o trade-off
contra o rastro explícito de dependências por rota da ADR-0004.

## Exemplo trabalhado: um slot de transação

Este é o modelo onion justificando seu valor. O app `examples/shop` expõe uma unidade
de trabalho por requisição como um scoped slot. O middleware abre uma transação a partir
do singleton `store`, preenche o slot `tx` e — criticamente — **faz rollback em qualquer caminho
que não tenha feito commit**:

```ts
import { defineMiddleware } from '../context'

export const withTransaction = defineMiddleware({
  provides: ['tx'] as const,
  handler: async (c, next) => {
    const tx = c.get('store').begin()
    c.set('tx', tx)
    try {
      await next()
    } catch (err) {
      tx.rollback()
      throw err
    }
    // Alcançado apenas quando o handler retornou sem fazer commit (ex.: ele
    // fez short-circuit com c.error). rollback() é um no-op depois do commit.
    if (tx.status === 'open') tx.rollback()
  },
})
```

É a forma canônica de um middleware que provê slot e também é dono da
limpeza, e você pode lê-la direto da onion — passos 1–2 acontecem na entrada, passos 4–5 na
saída:

1. **Abra** o recurso a partir de um singleton (`c.get('store').begin()`).
2. **Preencha** o scoped slot (`c.set('tx', tx)`) para que o handler possa montar trabalho sobre ele.
3. **Rode** o resto da cadeia dentro de `try { await next() }`.
4. **Faça rollback em um throw**, depois re-lance para que o erro ainda alcance a
   fronteira 5xx.
5. **Faça rollback depois de `next()`** se o handler nunca fez commit — um
   short-circuit precoce com `c.error(...)` devolve o controle aqui com a
   transação ainda `open`.

O handler lê o slot, monta suas escritas e faz commit explicitamente no sucesso;
qualquer outra coisa deixa a transação sem commit, e o middleware descarta o
trabalho montado — então uma escrita parcial nunca alcança o store. O tipo do slot
vem de `defineContext` (`tx: scoped<Transaction>()`), então `c.get('tx')` é
totalmente tipado no handler.

## Veja também

- [Context & DI](/pt/guide/context-di) — declarando singletons e scoped slots.
- [Routes & schemas](/pt/guide/routes-schemas) — `defineRoute`, `use:` e o contrato `output`.
- [App-level middleware](/pt/guide/app-middleware) — a cadeia global em profundidade.
- [JWT auth](/pt/guide/jwt) — `jwtAuth`, guards e o slot `currentUser`.
- [Errors](/pt/guide/errors) — o envelope unificado que `c.error` constrói.
