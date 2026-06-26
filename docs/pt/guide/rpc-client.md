---
title: Cliente RPC tipado
description: Como createApp retorna um app Hono paramétrico cujo tipo dá ao cliente hc tipos ponta a ponta a partir dos seus schemas Zod — sem codegen, sem runtime compartilhado.
---

# Cliente RPC tipado

Um servidor Kata já declara o `input` e o `output` de cada route como schemas
Zod. O cliente RPC reaproveita essas declarações: ele infere paths, corpos de
requisição, params, query e respostas por status diretamente dos mesmos schemas
contra os quais o servidor valida. Sem codegen. Sem runtime compartilhado. O
único artefato que um cliente importa é um tipo exportado.

Este é o [cliente RPC](https://hono.dev/docs/guides/rpc) do Hono. O trabalho do
Kata é fazer `createApp` retornar um app Hono cujo tipo carrega suas routes, para
que o `hc` tenha algo de onde inferir.

## O tipo do app

`createApp` retorna um app `Hono` **paramétrico**. Seu schema RPC é derivado dos
modules que você passa. Exporte o tipo desse app — esse é todo o contrato de que
um cliente precisa.

```ts
// server.ts
import { createApp } from './context'
import * as users from './modules/users/users.route'

const modules = [users] as const

export const app = createApp({ modules })

// A única coisa que um cliente importa.
export type AppType = typeof app
```

`createApp` infere sua tupla de modules com um type parameter `const`, então o `as const` em
`modules` é o que mantém os tipos dos elementos literais — sem ele, o TypeScript iria alargá-los
e os detalhes por rota seriam perdidos. `AppType` é exatamente
`KataApp<typeof modules>` — o mesmo tipo escrito de duas formas.

::: tip
`KataApp` é exportado de `kata` se você quiser nomear o tipo explicitamente:

```ts
import type { KataApp } from 'katajs'

export type Modules = typeof modules
export type AppType = KataApp<Modules> // ≡ typeof app
```

Você raramente precisa disso — `typeof app` é suficiente.
:::

## O cliente

Um cliente importa **apenas** `AppType` e o passa para `hc`:

```ts
// client.ts
import { hc } from 'hono/client'

import type { AppType } from './server' // num deploy real: do pacote do servidor

const client = hc<AppType>('http://localhost:3001')
```

Num deployment real o servidor vive em um pacote e o cliente em outro — um
frontend, um microsserviço, uma CLI. A única coisa que eles compartilham é o import de `AppType`, e
como um tipo é apagado em tempo de build, o cliente não carrega nenhuma dependência de runtime do
servidor e não há cliente gerado para manter em sincronia.

## Chamando routes

O cliente espelha sua árvore de rotas: cada segmento de path vira uma propriedade, e cada método
HTTP vira uma chamada prefixada com `$` (`$get`, `$post`). Os inputs de requisição que você declarou
em `input` mapeiam para os targets de cliente do Hono assim:

| Chave `input` do Kata | Target do cliente |
| --- | --- |
| `body` | `json` |
| `params` | `param` |
| `query` | `query` |
| `headers` | `header` |

Um path param como `/users/:id` é acessado pelo seu segmento literal,
`client.users[':id']`.

```ts
// POST /users — body inferido de CreateUserBodySchema
const created = await client.users.$post({ json: { name: 'Ada', email: 'ada@example.com' } })
const user = await created.json() // { id: string; name: string; email: string }

// GET /users/:id — param inferido de GetUserParamsSchema
const fetched = await client.users[':id'].$get({ param: { id: user.id } })

// GET /users?q=… — query inferida de ListUsersQuerySchema
const all = await client.users.$get({ query: { q: 'grace' } })
const list = await all.json() // { id: string; name: string; email: string }[]
```

Os tipos de requisição são derivados de `z.input` — o formato que o chamador envia, antes de quaisquer
transforms do Zod. Os tipos de resposta são derivados de `z.infer` — o formato depois do parsing.

## Chamadas erradas são erros de compilação

Como os inputs vêm dos seus schemas, uma chamada que os viola não passa na checagem de tipos.
Estas três instruções falham no `tsc`:

```ts
// O body deve satisfazer CreateUserBodySchema — email é obrigatório.
await client.users.$post({ json: { name: 'no-email' } }) // ✗

// O path param `id` é uma string, não um number.
await client.users[':id'].$get({ param: { id: 123 } }) // ✗

// A query `q` é uma string, não um number.
await client.users.$get({ query: { q: 123 } }) // ✗
```

Você não tem uma surpresa em runtime. Você tem um rabisco vermelho no editor e uma checagem de
tipos falhando no CI.

## Respostas multi-status se estreitam em `res.status`

Quando uma route declara um `output` mapeando status→schema (veja [Rotas & schemas](/pt/guide/routes-schemas)),
a resposta é uma união por status. Estreite-a com `res.status`, e cada branch fica tipada para o schema daquele status.

A route `/users/:id` declara `output: { 200: UserSchema, 404: ErrorBodySchema }`:

```ts
const res = await client.users[':id'].$get({ param: { id } })

if (res.status === 404) {
  const { error, message } = await res.json() // o envelope de erro: { error, message, issues? }
  return { notFound: true as const, error, message }
}

return res.json() // { id: string; name: string; email: string }
```

`ErrorBodySchema` (exportado de `kata`) é o schema canônico do envelope de erro do
Kata, então o branch 404 fica tipado de ponta a ponta. Veja [Erros](/pt/guide/errors) para o
formato do envelope e `c.error(...)`.

## Extraindo os tipos diretamente

Se você precisa do tipo de requisição ou resposta inferido para um call site — para tipar o parâmetro
de uma função ou um hook React — use `InferRequestType` e `InferResponseType` do Hono:

```ts
import type { InferRequestType, InferResponseType } from 'hono'

type CreateUserBody = InferRequestType<typeof client.users.$post>['json']
// { name: string; email: string }

type UserResponse = InferResponseType<(typeof client.users)[':id']['$get'], 200>
// { id: string; name: string; email: string }

type NotFoundResponse = InferResponseType<(typeof client.users)[':id']['$get'], 404>
// o envelope de erro, estreitado para o status 404
```

O segundo argumento de `InferResponseType` é o status para o qual você está estreitando — o
mesmo status em que você ramifica em runtime.

## O registry de DI nunca chega ao fio

Um servidor registra dependências em `defineContext` — um logger, um pool de db, scoped slots
como `currentUser` (veja [Context & DI](/pt/guide/context-di)). Nada disso faz parte do
contrato HTTP, então nada disso aparece no tipo do cliente — o que é exatamente o que você
quer: uma conexão de banco de dados e seus serviços internos são preocupações apenas do servidor, e eles
não têm motivo para vazar para os tipos de um frontend. O `Env` Hono do cliente permanece
`BlankEnv`.

```ts
import type { Hono } from 'hono'
import type { BlankEnv } from 'hono/types'

type EnvOf<T> = T extends Hono<infer E, infer _S, infer _B> ? E : never

// Vale — DI é só do servidor.
type _Proof = EnvOf<AppType> extends BlankEnv ? true : false
```

Então `c.get('logger')` funciona dentro de um handler, mas é invisível para `hc<AppType>`. O fio
carrega routes, inputs e outputs — nunca o seu registry.

## Testando o cliente in-process

O `testClient` de `hono/testing` vincula `hc<typeof app>` diretamente ao objeto do seu app, sem
socket. As chamadas dirigem o pipeline completo do Kata — validação de input, handler, validação de
output — com os mesmos tipos que o cliente real enxerga, de modo que seus testes e sua camada de tipos não
podem divergir.

```ts
import { testClient } from 'hono/testing'
import { describe, expect, it } from 'vitest'

import { app } from './server'

describe('users RPC', () => {
  const client = testClient(app)

  it('creates a user and reads it back with typed bodies', async () => {
    const created = await client.users.$post({ json: { name: 'Ada', email: 'ada@example.com' } })
    expect(created.status).toBe(200)
    const user = await created.json()

    const fetched = await client.users[':id'].$get({ param: { id: user.id } })
    expect(fetched.status).toBe(200)
    expect(await fetched.json()).toEqual(user)
  })

  it('rejects an invalid body at runtime with 422', async () => {
    const res = await client.users.$post({ json: { name: '', email: 'not-an-email' } })
    expect(res.status).toBe(422)
  })
})
```

## Exemplo trabalhado

[`examples/hello-client`](https://github.com/VicenzoMF/kata/tree/main/examples/hello-client)
é uma demonstração executável e checada por tipos de tudo acima:

- `src/server.ts` constrói o app e exporta `AppType`.
- `src/client.ts` o consome com `hc<AppType>`, mais uma tupla de provas de tipo em tempo de
  compilação e linhas `@ts-expect-error` que falham no `tsc` no momento em que o runtime e a
  camada de tipos discordam.
- `src/client.test.ts` exercita as mesmas rotas em runtime através de `testClient(app)`.

As provas de tipo são o teste: `tsc --noEmit` roda no CI, então uma regressão na
ponte runtime-para-tipo torna uma prova `false` e quebra o build.
