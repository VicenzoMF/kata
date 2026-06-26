---
title: defineContext
description: O único registry de dependências — slots singleton e scoped, a factory vinculada, e como c.get é tipado.
---

# defineContext

`defineContext` é o único lugar onde dependências são registradas. Não há
container de IoC em runtime nem service locator com chaves em string: o registry é um
objeto simples, e as chaves que você passa se tornam as únicas chaves que `c.get` vai aceitar.
Ele é importado a partir do entry point do core, junto com os dois construtores de slot.

```ts
import { defineContext, scoped, singleton } from 'katajs'
```

## Assinatura

`defineContext` recebe um argumento — o registry — e retorna as factory
functions vinculadas a ele.

```ts
function defineContext<const R extends Registry>(
  registry: R,
): {
  registry: R
  defineMiddleware: /* bound to R */
  defineRoute: /* bound to R */
  createApp: /* bound to R */
}
```

O type parameter `const` preserva o tipo literal exato do registry —
cada chave, e se seu slot é singleton ou scoped — para que essa informação
flua para cada route, middleware e chamada de `c.get` adiante.

Um `Registry` é um record somente leitura de slots:

```ts
type Slot = Singleton<unknown> | Scoped<unknown>
type Registry = Readonly<Record<string, Slot>>
```

## Construtores de slot

Um valor de registry nunca é um valor puro. Ele é um slot, construído por um de dois
construtores, que marca o valor com seu tempo de vida ([ADR-0004](/adr/0004-di-via-scoped-slots)).

### `singleton`

```ts
function singleton<T>(value: T): Singleton<T>
```

`singleton(value)` mantém um único valor por toda a vida do processo. Use para coisas
criadas uma vez no boot: um pool de banco de dados, um logger, um mailer, um objeto de
configuração. O valor é resolvido de forma eager — você o passa aqui, e todo
`c.get` retorna essa mesma referência.

```ts
const logger: Logger = {
  info: (msg, extra) => console.log(`[app] ${msg}`, extra ?? ''),
}

const slots = {
  logger: singleton(logger),
}
```

### `scoped`

```ts
function scoped<T>(): Scoped<T>
```

`scoped<T>()` declara um valor por requisição. Não recebe argumento — não há
nada a fornecer no momento do registro. O valor é preenchido depois, por
requisição, por um middleware que declara o slot na sua lista `provides:` e
o define com `c.set` (veja [Middleware](/pt/guide/middleware) e
[`defineMiddleware`](/pt/reference/define-middleware)). Use para o usuário
atual, um id de tenant ou uma transação por requisição.

```ts
const slots = {
  currentUser: scoped<User>(),
  tx: scoped<Transaction>(),
}
```

::: warning Ler um slot scoped antes de ser definido lança erro
Um slot scoped não tem valor até o middleware provedor rodar. Ler um deles em
um handler cuja cadeia `use:` nunca o preenche lança erro em runtime:

```
kata: scoped slot 'currentUser' read before being set. Did the providing middleware run?
```

Uma route que lê um slot scoped precisa listar o middleware provedor na sua
cadeia `use:`, ou registrá-lo como middleware de nível de app em
[`createApp`](/pt/reference/create-app).
:::

## A factory retornada

`defineContext` retorna quatro membros, todos vinculados ao seu registry `R`:

| Membro | Tipo | Propósito |
| --- | --- | --- |
| `registry` | `R` | O registry literal, para `typeof k.registry`. |
| `defineRoute` | bound | [`defineRoute`](/pt/reference/define-route) — seu `c.get` e `use:` conhecem `R`. |
| `defineMiddleware` | bound | [`defineMiddleware`](/pt/reference/define-middleware) — `provides:` é chaveado aos seus slots scoped. |
| `createApp` | bound | [`createApp`](/pt/reference/create-app) — constrói o app Hono. |

Defina o context uma vez, em `src/context.ts`, e então re-exporte as factory
functions vinculadas. O resto do app as importa de lá e herda os tipos
automaticamente — nada mais jamais chama `defineContext`.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import type { User } from './modules/users/users.schema'

type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[app] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  logger: singleton(logger),
  currentUser: scoped<User>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

::: tip Exporte o tipo do registry
`export type AppRegistry = typeof k.registry` dá a você um nome para o formato
do registry. É o `R` que parametriza `Route<R>` e `Middleware<R>`, útil
quando você escreve um helper genérico sobre qualquer context.
:::

## Como `c.get` é tipado

`c.get` é a única forma de ler uma dependência, tanto em handlers de route quanto
de middleware. Seu parâmetro de chave é restrito a `keyof R`, então uma chave não registrada
é um erro de compilação — não uma surpresa em runtime:

```ts
get<K extends keyof R>(key: K): ResolvedValue<R[K]>
```

O tipo de retorno é desempacotado do slot por `ResolvedValue`, então você recebe de volta
o tipo do valor subjacente, não o wrapper do slot:

```ts
type ResolvedValue<S> =
  S extends Singleton<infer T> ? T : S extends Scoped<infer T> ? T : never
```

Dado o context acima:

```ts
const log = c.get('logger') // Logger
const user = c.get('currentUser') // User
c.get('mailer') // ✗ erro de compilação — não registrado em defineContext
```

::: info Chaves scoped são tipadas em todo lugar onde `get` é chamável
No v1, `c.get` tipa toda chave registrada em um handler, incluindo as scoped —
se a cadeia de middleware da route de fato proveu um dado slot scoped é uma
questão de lint, não um erro de tipo. Ler um slot scoped não provido ainda lança
erro em runtime, como mostrado acima. Veja [ADR-0004](/adr/0004-di-via-scoped-slots).
:::

## Exemplo prático

Um context com ambos os tipos de slot, a factory vinculada re-exportada, e um handler
que lê cada um:

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import type { Store } from './store'
import { createStore } from './store'

export type CurrentUser = { id: string }

export const k = defineContext({
  store: singleton<Store>(createStore()),
  currentUser: scoped<CurrentUser>(),
})

export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

```ts
// src/modules/orders/orders.route.ts
import { z } from 'zod'

import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'
import { OrderSchema } from './orders.schema'
import { listOrders } from './orders.service'

export const list = defineRoute({
  method: 'GET',
  path: '/orders',
  use: [requireUser], // preenche o slot scoped `currentUser`
  input: {},
  output: z.array(OrderSchema),
  handler: (c) => {
    const store = c.get('store') // Store — singleton, sempre disponível
    const user = c.get('currentUser') // CurrentUser — provido por requireUser
    return listOrders(store, user.id)
  },
})
```

## Tipos auxiliares

Estes são exportados a partir do entry point do core para uso avançado — escrever uma
função genérica sobre qualquer registry, ou inspecionar tipos de slot. Você raramente precisa
deles em código de aplicação.

| Tipo | Significado |
| --- | --- |
| `Singleton<T>` | Um slot de vida de processo que mantém um `T`. |
| `Scoped<T>` | Um slot por requisição para um `T`, preenchido por middleware. |
| `Slot` | `Singleton<unknown> \| Scoped<unknown>`. |
| `Registry` | `Readonly<Record<string, Slot>>`. |
| `ResolvedValue<S>` | O tipo de valor que um slot `S` resolve. |
| `SingletonKeys<R>` | A união das chaves em `R` cujo slot é singleton. |
| `ScopedKeys<R>` | A união das chaves em `R` cujo slot é scoped. |

## Veja também

- [Context e DI](/pt/guide/context-di) — o guia conceitual.
- [Middleware](/pt/guide/middleware) — como slots scoped são preenchidos.
- [`defineMiddleware`](/pt/reference/define-middleware) — o contrato `provides:`.
- [`defineRoute`](/pt/reference/define-route) — `c.get` e `use:` em um handler.
- [`createApp`](/pt/reference/create-app) — montando módulos e middleware.
- [ADR-0004](/adr/0004-di-via-scoped-slots) — por que DI são dois tipos de slot e nada mais.
