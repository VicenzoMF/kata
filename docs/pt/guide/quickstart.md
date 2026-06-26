---
title: Início rápido
description: Construa uma API /users totalmente tipada em seis arquivos, suba ela e chame ela — incluindo falhas de validação e a rota /me protegida por JWT.
---

# Início rápido

Isto constrói uma API `/users` totalmente tipada — crie um usuário, busque-o de volta, observe uma
falha de validação e chame uma rota `/me` protegida por JWT — em seis pequenos arquivos. Isto é exatamente
[`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello).

O plano: leia os seis arquivos de cima a baixo (cada um introduz uma ideia do Kata),
suba o app, depois chame ele com `curl` e observe cada contrato se manter. Cada passo
tem links para o guia de conceito que o cobre em profundidade, para que você possa dar uma olhada rápida aqui e
se aprofundar depois.

## Instalação

Kata tem duas peer dependencies — Hono (a base HTTP) e Zod (schemas) — mais
o adaptador Node do Hono para subir um servidor no Node.

```bash
npm install katajs hono zod @hono/node-server
# ou: pnpm add katajs hono zod @hono/node-server
```

::: info Nome do pacote vs. comando
O framework é o **Kata**, mas seu pacote no npm é **`katajs`** — o nome `kata`
puro no npm pertence a um pacote sem relação e parado. Então você **instala e
importa `katajs`** (`import … from 'katajs'`), enquanto a CLI mantém o comando
curto **`kata`** (`kata init`, `kata verify`). `npx katajs …` também funciona, como alias.
:::

::: warning Pré-lançamento
Kata ainda não foi publicado no npm. Hoje o caminho mais rápido é clonar o repositório
e rodar o exemplo completo, que é o que o restante desta página percorre.

```bash
git clone https://github.com/VicenzoMF/kata.git
cd kata && pnpm install
pnpm --filter=hello dev      # sobe examples/hello em http://localhost:3000
```
:::

## Os seis arquivos

Kata trava o layout de pastas para que cada route, service, schema e teste seja
localizável por glob (veja [layout do projeto](/pt/guide/project-layout)). O exemplo
dobra `app.ts` dentro de `main.ts`, deixando seis arquivos:

```
examples/hello/src/
├── context.ts                       # defineContext({ ... })
├── middlewares/
│   └── auth.ts                       # jwtAuth → preenche o slot currentUser
└── modules/users/
    ├── users.schema.ts               # DTOs Zod
    ├── users.service.ts              # funções puras
    └── users.route.ts                # apenas chamadas defineRoute
main.ts                               # createApp + serve
```

### 1. Declare cada dependência uma vez — `context.ts`

`defineContext` é o único lugar onde dependências são registradas. Há dois
tipos de slot:

- `singleton(value)` — vive durante todo o tempo de vida do processo (pool do db, logger, mailer).
- `scoped<T>()` — um valor por request, preenchido por um middleware (usuário atual,
  tenant id, request id).

`defineContext` retorna `defineRoute`, `defineMiddleware` e `createApp`
já vinculados ao seu registry. Reexporte-os para que o resto da aplicação herde
os tipos — `c.get('key')` só passa na checagem de tipos para chaves que você registrou aqui.

```ts
import { defineContext, scoped, singleton } from 'katajs'

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

Veja [context & DI](/pt/guide/context-di) para o modelo completo de slots.

### 2. Schemas (DTOs) — `modules/users/users.schema.ts`

Os schemas Zod de cada domínio vivem em `<domain>.schema.ts`, nunca inline na
route. Exporte os tipos `z.infer` ao lado deles, para que um único import traga tanto
o schema em runtime quanto o tipo em tempo de compilação.

```ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

export const GetUserParamsSchema = z.object({
  id: z.string(),
})

export type User = z.infer<typeof UserSchema>
export type UserClaims = z.infer<typeof UserClaimsSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

### 3. Lógica de negócio — `modules/users/users.service.ts`

Services são funções simples e puras — triviais de testar unitariamente, sem imports
de framework. O `Map` em memória aqui faz as vezes de um store real.

```ts
import type { CreateUserBody, User } from './users.schema'

const store = new Map<string, User>()

export async function getUser(id: string): Promise<User | null> {
  return store.get(id) ?? null
}

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  store.set(id, user)
  return user
}
```

Mais sobre a fronteira em [services](/pt/guide/services).

### 4. Middleware & scoped slots — `middlewares/auth.ts`

Um middleware declara quais scoped slots ele `provides`; seu handler os preenche.
Retornar uma `Response` curto-circuita o request antes do handler rodar.

Kata vem com auth JWT sob `katajs/jwt`. `jwtAuth` lê um token `Authorization: Bearer`,
verifica a assinatura e as claims de tempo, faz o parse do payload com seu schema
Zod e preenche o slot. O hook `resolve()` mapeia as claims validadas para o
`User` da aplicação. Mantenha o wrapper `defineMiddleware` para que o literal `provides`
continue greppável e checável pelo lint.

```ts
import { jwtAuth } from 'katajs/jwt'

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

`JWT_SECRET` vive num pequeno `config.ts` e é compartilhado com a rota de emissão
de token abaixo — eles precisam concordar ou todo token falha na verificação:

```ts
export const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret'
export const TOKEN_TTL_SECONDS = 60 * 60
```

::: warning
`dev-secret` mantém o exemplo zero-config. Uma aplicação real define `JWT_SECRET` a partir do
ambiente e se recusa a subir em produção quando ele não está definido. Nunca leve
`dev-secret` para produção.
:::

Para preencher um slot com `c.set` diretamente, ou para acrescentar autorização com
`requireRole` / `guard`, veja [middleware](/pt/guide/middleware) e o
[cookbook de auth](/pt/cookbook/auth).

### 5. Routes — `modules/users/users.route.ts`

Toda route declara schemas obrigatórios de `input` e `output` — omitir qualquer um é
um erro de TypeScript. Dentro do handler, `c.input` é totalmente tipado a partir dos schemas
de input. Um handler pode tanto **retornar um valor** (validado contra `output`,
depois serializado) quanto **retornar `c.json(...)` / `c.error(...)`** para definir um status
customizado.

`output` pode ser um único schema (o corpo 200) ou um mapa status→schema —
`{ 200: UserSchema, 404: ErrorBodySchema }` — que tipa e valida cada
status. `ErrorBodySchema` é o envelope de erro unificado do Kata, a coisa canônica
para colocar atrás de um status 4xx/5xx. Routes que leem um scoped slot listam o
middleware provedor em `use:`.

```ts
import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
```

`c.get('currentUser')` em `meRoute` passa na checagem de tipos apenas porque `requireUser`
provê esse slot e está listado em `use:`. Referência completa em
[routes & schemas](/pt/guide/routes-schemas).

### 6. Suba ela — `main.ts`

`createApp({ modules })` conecta cada route exportada em cada módulo a um app
Hono. Um módulo é apenas o import de namespace de um arquivo `.route.ts`. Entregue
`app.fetch` ao `@hono/node-server` para escutar.

Middleware transversal vai no slot opcional `middlewares` — uma cadeia que
roda **antes** do `use:` próprio de cada route. Os built-ins de endurecimento
de primeira mão (`cors()`, `secureHeaders()`, `bodyLimit()`) são o caso canônico: declare-os
uma vez e toda route fica coberta.

```ts
import { serve } from '@hono/node-server'
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp, k } from './context'
import * as auth from './modules/auth/auth.route'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users, auth],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

::: tip
O exemplo também passa `requestLogging: true` e um botão explícito de
`outputValidation`. Ambos são opcionais. Veja [app middleware](/pt/guide/app-middleware)
e [ciclo de vida](/pt/guide/lifecycle).
:::

A rota de emissão de token importada acima (`modules/auth/auth.route.ts`) assina um
JWT com `signJwt` para que você possa exercitar `/me` sem ferramentas externas. Ela confia
em quem a chama e **não** é como você autentica usuários reais:

```ts
import { signJwt } from 'katajs/jwt'

import { JWT_SECRET, TOKEN_TTL_SECONDS } from '../../config'
import { defineRoute } from '../../context'

import { TokenRequestSchema, TokenResponseSchema } from './auth.schema'

export const mintTokenRoute = defineRoute({
  method: 'POST',
  path: '/auth/token',
  input: { body: TokenRequestSchema },
  output: TokenResponseSchema,
  handler: async (c) => {
    const { id, name, email } = c.input.body
    const token = await signJwt(
      { name, email },
      { secret: JWT_SECRET, subject: id, expiresInSeconds: TOKEN_TTL_SECONDS },
    )
    return { token }
  },
})
```

A costura real para login, hashing de senha e refresh é sua — veja o
[guia de JWT](/pt/guide/jwt) e o [cookbook de auth](/pt/cookbook/auth).

## Rode ela

A partir do repositório clonado, o exemplo está conectado com [`tsx`](https://tsx.is):

```bash
pnpm --filter=hello dev      # tsx watch src/main.ts → http://localhost:3000
```

Em um projeto standalone, adicione `tsx` (`npm i -D tsx`) e rode `tsx watch src/main.ts`.

## Chame ela

Crie um usuário, depois busque ele de volta:

```bash
# Cria um usuário (corpo válido) → 200, validado contra UserSchema
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com"}'
# {"id":"f81d4fae-…","name":"Ada","email":"ada@example.com"}

# Busca ele de volta por id → 200
curl -s localhost:3000/users/f81d4fae-…

# Id desconhecido → 404, o envelope de erro unificado vindo de c.error
curl -s localhost:3000/users/none
# {"error":"not_found","message":"User not found"}
```

### A validação falha antes do seu handler

Kata valida `input` **antes** do handler rodar. Em caso de falha ele responde
`422` com um envelope normalizado: `error: "validation_failed"` mais `issues`
indexado pela seção do input que falhou (`params`, `query`, `body` ou
`headers`).

```bash
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"name":"","email":"not-an-email"}'
```

```json
{
  "error": "validation_failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "String must contain at least 1 character(s)" },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Cada issue de campo é `{ path, message, code }`, com `expected` / `received`
opcionais para incompatibilidades de tipo. O output também é validado, **depois** do handler
retornar: um valor que não bate com seu schema de `output` produz
`500 {"error":"internal_output_shape_mismatch"}` e é logado no servidor — o
formato errado nunca chega ao cliente. Tratamento completo em [errors](/pt/guide/errors).

### O fluxo de `/me` protegido por JWT

Emita um token, depois chame `/me` com ele:

```bash
# Emite um token para uma identidade (faz as vezes de um login real)
curl -s localhost:3000/auth/token \
  -H 'content-type: application/json' \
  -d '{"id":"42","name":"Ada","email":"ada@example.com"}'
# {"token":"eyJhbGc…"}

# Sem token → 401, o envelope unificado
curl -s localhost:3000/me
# {"error":"unauthorized","message":"Missing bearer token"}

# Com o token → 200, o currentUser resolvido
curl -s localhost:3000/me -H 'Authorization: Bearer eyJhbGc…'
# {"id":"42","name":"Ada","email":"ada@example.com"}
```

`requireUser` verifica o token, faz o parse das claims com `UserClaimsSchema`
e `resolve()` as remodela para o slot `currentUser` que `meRoute` lê.

## Para onde ir depois

- [Context & DI](/pt/guide/context-di) — singletons, scoped slots e o registry.
- [Routes & schemas](/pt/guide/routes-schemas) — contratos de input/output em profundidade.
- [Middleware](/pt/guide/middleware) e [app middleware](/pt/guide/app-middleware) — preenchimento de slots e a cadeia global.
- [Errors](/pt/guide/errors) — os envelopes 422/500 e `c.error`.
- [JWT](/pt/guide/jwt) — auth real, guards e o hook `resolve()`.
- [RPC client](/pt/guide/rpc-client) — `hc<AppType>` para chamadas tipadas ponta a ponta, sem codegen.
- [Layout do projeto](/pt/guide/project-layout) — a estrutura de pastas travada.
