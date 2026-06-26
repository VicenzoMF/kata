---
title: Estrutura do projeto
description: A árvore src/ travada, por que cada arquivo é localizável pelo sufixo e como a estrutura alimenta o kata verify.
---

# Estrutura do projeto

O Kata trava a estrutura de pastas. Toda route, service, schema e test fica em um
caminho que você consegue prever a partir do nome do domínio. Nada fica solto. Isso não é uma
preferência de estilo — é o contrato que o `kata verify` lê, e a razão pela qual um agente consegue
encontrar o arquivo de que precisa sem buscar.

## A árvore

```
src/
├── app.ts                    # createApp({ modules, middlewares? })  — opcional
├── context.ts                # defineContext({ ... }) — o registry de DI
├── main.ts                   # boot: serve(app.fetch, ...)
├── middlewares/              # middleware transversal (auth, tx, ...)
└── modules/
    └── <domain>/
        ├── <domain>.route.ts     # apenas chamadas de defineRoute
        ├── <domain>.service.ts   # funções puras
        ├── <domain>.schema.ts    # schemas Zod (DTOs)
        ├── <domain>.hurl         # E2E de API (Hurl)
        └── <domain>.test.ts      # testes unitários
```

`context.ts` é especial. Ele contém sua única chamada `defineContext({...})` e
re-exporta `defineRoute`, `defineMiddleware` e `createApp` já vinculados ao
registry. O harness de verify lê exatamente esse arquivo para descobrir quais chaves
`c.get(...)` pode usar, então ele precisa ser `src/context.ts` — não renomeado, não dividido.

Um domínio é uma pasta dentro de `src/modules/`. Seus arquivos compartilham o prefixo do domínio:
o domínio `users` é `users.route.ts`, `users.service.ts`, `users.schema.ts`,
e assim por diante. Uma pasta, um prefixo, sem exceções.

## Por que a localizabilidade importa

Aqui está a ideia estrutural: **o sufixo é o tipo do arquivo.** Um arquivo chamado
`users.route.ts` contém declarações de route; `users.schema.ts` contém DTOs Zod;
`users.service.ts` contém funções puras. Como o sufixo carrega esse significado,
tanto o ferramental quanto as pessoas conseguem localizar qualquer arquivo só pelo nome:

```bash
# toda route do app
ls src/modules/*/*.route.ts

# todo DTO
ls src/modules/*/*.schema.ts

# o service de um domínio
cat src/modules/users/users.service.ts
```

`kata verify` percorre `src/` e despacha regras pelo sufixo — sem biblioteca de glob, sem config.
A varredura pula os diretórios `node_modules`, `dist`, `build`, `coverage`, `data` e `.git`,
e descarta arquivos `*.test.ts`, `*.d.ts` e `*.schema.ts` antes de qualquer regra
rodar. Cada arquivo restante é roteado pelo seu nome:

- `*.route.ts` → verificado quanto a `input` / `output` obrigatórios, schemas inline e
  chaves de contexto não registradas ou não providas.
- `*.service.ts` → verificado quanto a schemas inline (um service é o outro lugar onde um
  `z.object(...)` perdido é rejeitado).
- `*.schema.ts` → o único lugar onde um schema Zod pode viver, então ele é excluído da varredura;
  nenhuma regra o lê.

Se você fizer inline de um schema em um `.route.ts`, ou colocar uma route em um arquivo com nome errado, as
verificações se baseiam no sufixo errado e o harness reporta isso. A estrutura é o que torna as regras
baratas e exatas. Veja [O harness](/pt/guide/harness) para o conjunto completo de regras.

::: warning Um prefixo por arquivo
`users.route.ts` está correto. `routes/users.ts`, `user-routes.ts` ou um
`UsersController` não estão — o sufixo carrega o significado, e o harness casa com
ele. Renomear `context.ts` quebra as verificações de DI da mesma forma.
:::

## `app.ts` vs. dobrá-lo em `main.ts`

`app.ts` constrói a aplicação — uma chamada `createApp({ modules, middlewares? })` — e
a exporta. `main.ts` é o entrypoint de runtime: ele importa o app e entrega
`app.fetch` a um servidor.

```ts
// src/app.ts
import { createApp } from './context'
import * as users from './modules/users/users.route'

export const app = createApp({ modules: [users] })
export type AppType = typeof app // o tipo que seu cliente RPC importa
```

```ts
// src/main.ts
import { serve } from '@hono/node-server'

import { app } from './app'
import { k } from './context'

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.resolve('logger').info(`listening on http://localhost:${info.port}`)
})
```

Por que dividi-los? Porque isso mantém o app construível em isolamento — seus testes e o
[cliente RPC tipado](/pt/guide/rpc-client) importam `AppType` de `app.ts` sem subir um
servidor, enquanto `main.ts` continua um script de boot enxuto que é dono do socket.

Para um serviço pequeno você pode **dobrar `app.ts` em `main.ts`** — chamar `createApp` inline
e servi-lo em um único arquivo. Ambos os exemplos prontos fazem exatamente isso:

```ts
// src/main.ts — examples/hello
import { serve } from '@hono/node-server'
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp, k } from './context'
import * as auth from './modules/auth/auth.route'
import * as diag from './modules/diag/diag.route'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users, auth, echo, diag],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.resolve('logger').info(`listening on http://localhost:${info.port}`)
})
```

`app.ts` é o único arquivo opcional na árvore. A divisão é o padrão certo quando você
tem um cliente RPC ou quer o app importável a partir dos testes; o dobramento é
adequado enquanto o app for um único arquivo. `context.ts` e os arquivos de módulo
nunca são opcionais.

## Dentro de um módulo

Cada pasta `<domain>/` é autocontida, com uma responsabilidade por arquivo:

- **`<domain>.schema.ts`** — schemas Zod e seus tipos inferidos. Os DTOs vivem aqui e
  em nenhum outro lugar ([`defineRoute`](/pt/reference/define-route), ADR-0005). Uma route importa seus
  schemas `input` / `output` desse arquivo.
- **`<domain>.service.ts`** — [funções puras](/pt/guide/services). Sem imports de framework,
  sem `c`. Trivial de testar unitariamente em isolamento.
- **`<domain>.route.ts`** — apenas chamadas de `defineRoute`. O handler valida `c.input`,
  chama services e retorna um valor (verificado contra `output`) ou `c.json(...)` /
  `c.error(...)`. Veja [Routes & schemas](/pt/guide/routes-schemas).
- **`<domain>.test.ts`** — testes unitários, tipicamente sobre o service.
- **`<domain>.hurl`** — requisições [Hurl](https://hurl.dev) que exercitam a superfície
  HTTP viva de ponta a ponta.

Um domínio real de `examples/hello`:

```
src/modules/users/
├── users.route.ts
├── users.schema.ts
├── users.service.ts
├── users.service.test.ts
└── users.hurl
```

::: tip Middleware transversal
Middleware que mais de um domínio usa — auth JWT, um slot de transação — pertence a
`src/middlewares/`, não dentro de um módulo. Cada um declara os scoped slots que `provides`;
veja [Middleware](/pt/guide/middleware) e [App-level middleware](/pt/guide/app-middleware).
Infraestrutura compartilhada não-HTTP (um `store.ts`, um pool de conexões) fica na raiz de `src/`,
como em `examples/shop`.
:::

## Scaffolding

`kata init` escreve esta estrutura travada para você — `src/app.ts`,
`src/context.ts`, `src/main.ts`, uma pasta `middlewares/` e dois módulos prontos
(`health` e `greetings`), cada um com o conjunto completo route / service / schema
/ test / hurl — para que um projeto novo comece no formato que o harness espera.
Adicione mais com `kata new <domain>`. Veja [Bootstrap CLI](/pt/guide/cli).
