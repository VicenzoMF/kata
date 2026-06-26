---
title: createApp
description: Conecte seus módulos e middlewares em um app Hono tipado e, então, sirva-o.
---

# createApp

`createApp` transforma seus módulos em um app Hono em execução. É a última chamada
do seu app: `defineContext` constrói o registry, `defineRoute` declara os
handlers, e `createApp` os reúne, prepõe a cadeia de middleware no nível do app
e retorna um app Hono paramétrico que você serve e do qual exporta um tipo.

`createApp` é uma das quatro funções que `defineContext` retorna. Chame a versão
vinculada, não um import livre — ela já está tipada para o seu registry.

```ts
import { defineContext, singleton } from 'katajs'

export const k = defineContext({ logger: singleton(console) })
export const { defineRoute, defineMiddleware, createApp } = k
```

## Assinatura

```ts
function createApp<const Mods extends readonly Module<R>[]>(
  config: AppConfig<R, Mods>,
): KataApp<Mods>
```

`config` é um `AppConfig`:

```ts
type AppConfig<R extends Registry, Mods extends readonly Module<R>[]> = {
  modules: Mods
  middlewares?: readonly Middleware<R>[]
  requestLogging?: boolean
  outputValidation?: 'strict' | 'log' | 'off'
}
```

### `modules` (obrigatório)

Uma tupla de módulos. Um **módulo** é o import de namespace de um arquivo
`*.route.ts` — `import * as users from './modules/users/users.route'`. `createApp`
registra cada route exportada em cada módulo, na ordem do array.

```ts
import { createApp } from './context'
import * as users from './modules/users/users.route'
import * as orders from './modules/orders/orders.route'

const app = createApp({ modules: [users, orders] })
```

O `path` e o `method` de uma route vêm da sua própria chamada `defineRoute`. `createApp`
não prefixa nem reescreve paths; o que você declara é o que é servido.

### `middlewares` (opcional)

Uma cadeia de middleware no nível do app que roda **antes** do `use:` de cada route. A
cadeia efetiva por route é `[...middlewares, ...route.use]`, cada uma na ordem
declarada, com a cadeia global mais externa ([ADR-0012](/adr/0012-app-level-middleware)).
É o mesmo contrato `Middleware<R>` que o middleware de route usa: um middleware global pode
fazer curto-circuito retornando uma `Response`, e qualquer scoped slot que ele
`provides:` é legível via `c.get` em todo handler.

Declare preocupações transversais uma vez aqui, em vez de repeti-las em cada route.
Os built-ins de hardening de primeira parte são o caso canônico:

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'

const app = createApp({
  modules: [users, orders],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

Veja [/pt/guide/app-middleware](/pt/guide/app-middleware) para ordenação e
semântica de curto-circuito, e [/pt/reference/middleware](/pt/reference/middleware) para
os built-ins.

### `requestLogging` (opcional)

Logging por requisição. O padrão é `true`. Quando habilitado e um singleton `logger`
está registrado, toda requisição é logada — método, path, status, duração e
id de requisição — através dele. É um no-op quando nenhum `logger` utilizável está registrado; defina
`false` para silenciá-lo explicitamente.

```ts
const app = createApp({ modules: [users], requestLogging: false })
```

O id de requisição também é ecoado no header de resposta `x-request-id`
(`REQUEST_ID_HEADER`).

### `outputValidation` (opcional)

Como uma divergência de output-schema é tratada ([ADR-0009](/adr/0009-output-validation-mode)):

- `'strict'` — loga os issues Zod ofensores e responde `500
  {"error":"internal_output_shape_mismatch"}`. A forma errada nunca chega ao
  client.
- `'log'` — loga os issues e, então, envia os dados do handler sem alteração.
- `'off'` — pula a validação de output por completo.

O padrão é `'strict'` fora de produção e `'log'` em produção. Sobrescreva aqui,
ou via a variável de ambiente `KATA_OUTPUT_VALIDATION`.

```ts
const app = createApp({
  modules: [users],
  outputValidation: process.env['NODE_ENV'] === 'production' ? 'log' : 'strict',
})
```

A validação de input não é configurável — input inválido sempre produz um `422`
antes de o handler rodar. Veja [/pt/guide/errors](/pt/guide/errors) para ambos os envelopes.

## O valor de retorno: `KataApp` e `AppType`

`createApp` retorna um `KataApp<Mods>` — um app Hono paramétrico cujo tipo carrega
cada route que os módulos declaram:

```ts
type KataApp<Mods extends readonly RpcModule[]> =
  Hono<BlankEnv, ModulesToHonoSchema<Mods>>
```

Em runtime, é um app Hono de verdade; o parâmetro de tipo é o que dá poder ao
client RPC tipado. Exporte esse tipo a partir do seu servidor — é a única coisa que um client
precisa:

```ts
export const app = createApp({ modules: [users] })
export type AppType = typeof app // ≡ KataApp<[typeof users]>
```

O registry de DI nunca chega ao fio, então o `Env` Hono do client permanece
`BlankEnv`. Um client consome o tipo com zero codegen:

```ts
import { hc } from 'hono/client'
import type { AppType } from 'server'

const client = hc<AppType>('http://localhost:3000')
```

Veja [/pt/guide/rpc-client](/pt/guide/rpc-client) para o passo a passo completo do client.

## Servindo o app

Como o valor de retorno é um app Hono, você o serve através de `app.fetch` — o
handler padrão Web `Request → Response` que o Hono expõe. No Node, entregue-o a
`@hono/node-server`:

```ts
import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

`createApp` instala **nenhum** signal handler e não é dono de nenhum socket de servidor. Ele constrói
o handler de requisição; `serve` é dono do socket. Optar por graceful shutdown é um
passo separado e explícito ([ADR-0014](/adr/0014-lifecycle-shutdown)).

### Graceful shutdown — `katajs/node`

O `serve()` do `@hono/node-server` retorna um handle de servidor. Passe-o para
`gracefulShutdown` de `katajs/node` para drenar requisições em andamento em `SIGTERM` /
`SIGINT` antes de o processo sair:

```ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'katajs/node'

import { createApp, k } from './context'
import * as products from './modules/products/products.route'

const app = createApp({ modules: [products] })

const port = Number(process.env['PORT'] ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})

gracefulShutdown(server, {
  onClose: async () => {
    await k.registry.store.__value.close()
  },
})
```

No primeiro sinal capturado, `gracefulShutdown` para de aceitar novas conexões,
deixa as requisições em andamento drenarem e, então, roda seu `onClose` — estritamente após o
drain, de modo que nenhum handler ativo perca seu pool ou transação no meio de uma query. A ordem
de teardown dos recursos é sua para sequenciar dentro de `onClose`; o Kata não é dono de nenhum
registry de dispose.

```ts
type GracefulShutdownOptions = {
  onClose: () => void | Promise<void>
  signals?: readonly NodeJS.Signals[] // default: ['SIGTERM', 'SIGINT']
  timeoutMs?: number                  // default: 10_000
}
```

::: tip
`katajs/node` é o único entry que toca em `node:process`. Importar a raiz
runtime-neutra (`katajs`) a partir de um build edge ou Workers nunca o puxa
([ADR-0014](/adr/0014-lifecycle-shutdown)).
:::

Veja [/pt/guide/lifecycle](/pt/guide/lifecycle) para a sequência completa de drain, o
timer de force-exit e a fronteira do `main.ts`.

### Outros runtimes

`app.fetch` é o handler universal. No Bun, Deno ou em um runtime edge/Workers,
entregue-o ao servidor daquela plataforma, em vez de `@hono/node-server`. O core do Kata
(`katajs`) é runtime-neutro; apenas `katajs/node` é específico do Node.

```ts
// Bun
export default { fetch: app.fetch }
```
