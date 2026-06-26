# Receita: Autenticação e autorização

**Problema:** identificar quem chama, rejeitar requisições não autenticadas,
tornar o usuário autenticado disponível para todo handler que precise dele — sem
uma variável global e sem propagar o usuário por toda assinatura de função — e
então **autorizar** rotas específicas por papel ou claim.

**Padrão:** um middleware que **provê um scoped slot**. É exatamente o formato
que a [ADR-0004](/adr/0004-di-via-scoped-slots) chama de _Pattern C_: scoped
slots são declarados de antemão em `defineContext`, e um middleware os preenche
por requisição. Um handler lê o usuário com `c.get('currentUser')` — o mesmo
acessor monomórfico usado para singletons.

A Kata entrega os blocos de construção de JWT em [`katajs/jwt`](/adr/0013-jwt-delivery),
então você não precisa mais escrever um verificador na mão:

| Função | Papel |
| --- | --- |
| `signJwt(claims, opts)` | assina um objeto de claims em um JWT compacto |
| `verifyJwt(token, opts)` | verifica + faz Zod-parse de um token → um `Result` (nunca lança) |
| `jwtAuth(opts)` | um **handler** de middleware que autentica uma requisição e preenche um slot |
| `guard(opts)` / `requireRole(...)` / `requireClaim(...)` | **handlers** de middleware que autorizam (403) |

O app de referência entrega uma versão funcional em
[`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello/src) — o middleware de auth em
[`middlewares/auth.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/middlewares/auth.ts), a
rota que emite tokens em
[`modules/auth`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/auth/auth.route.ts). Esta
receita percorre tudo isso.

## 1. Declare o scoped slot

Scoped slots ficam em `defineContext` ao lado dos singletons. `scoped<T>()` não
recebe valor — ele apenas declara o tipo que um middleware vai `set` mais tarde.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import type { User } from './modules/users/users.schema'

export const k = defineContext({
  logger: singleton(makeLogger()),
  currentUser: scoped<User>(), // ← um User por requisição
})

export const { defineRoute, defineMiddleware, createApp } = k
```

## 2. Descreva os claims do token

O payload dentro de um JWT é apenas dado até você validá-lo. Declare um schema
Zod para os claims que você espera; `jwtAuth` faz parse de todo token decodificado
através dele, então um payload controlado por um atacante nunca chega ao seu
handler como um blob sem tipo (`any` é proibido — veja [AGENTS.md](https://github.com/VicenzoMF/kata/blob/main/AGENTS.md)). Schemas ficam em
`<domain>.schema.ts` ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)):

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

// `sub` é o claim padrão de subject do JWT (o id do usuário); `name`/`email`
// seguem junto como claims extras. Claims registrados como `iat`/`exp` são
// removidos por este object schema.
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

export type User = z.infer<typeof UserSchema>
export type UserClaims = z.infer<typeof UserClaimsSchema>
```

## 3. Autentique com `jwtAuth`

`jwtAuth` retorna um **handler** de middleware — ele lê o header `Authorization: Bearer <token>`, verifica a assinatura e os claims de tempo, faz parse do payload através do seu
schema de `claims` e preenche um scoped slot. Você o embrulha com `defineMiddleware`, de modo que
o literal de `provides` fique no call site onde o sistema de tipos e a
regra de lint `kata/middleware-provides-mismatch` podem checá-lo.

O **hook `resolve()`** mapeia os claims validados para o valor que cai no
slot. Como o slot `currentUser` é tipado como `User`, `resolve` transforma os claims
em um `User`. Aqui o token já carrega tudo que `User` precisa, então é um
reshape puro — mas `resolve` é também a costura onde um app real carrega o usuário
completo do seu banco de dados por `claims.sub` (retornar `null`/`undefined` para um
subject desconhecido produz um 401):

```ts
// src/middlewares/auth.ts
import { jwtAuth } from 'katajs/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    // claims → User. Em um app real: `resolve: (claims) => db.users.find(claims.sub)`.
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

`provides: ['currentUser'] as const` é estrutural: o `as const` mantém os
tipos literais das chaves, de modo que o sistema de tipos e a regra de lint
`kata/jwt-auth-provides-slot` possam checar que um middleware `jwtAuth({ slot })`
declara o slot que ele preenche. O `jwtAuth` faz seu `c.set` internamente, então
a regra genérica `kata/middleware-provides-mismatch` não consegue ver essa
atribuição — `kata/jwt-auth-provides-slot` (ADR-0013) é o que impõe esse contrato.

Toda falha de autenticação curto-circuita a cadeia com o envelope unificado da
ADR-0008 como um **401** — o handler nunca roda:

| Situação | `error` | `message` |
| --- | --- | --- |
| header `Authorization` ausente / malformado | `unauthorized` | `Missing bearer token` |
| assinatura inválida, alg errado, expirado | `unauthorized` | `Invalid or expired token` |
| payload falha em `claims` | `unauthorized` | `Token claims did not match` (com `issues.claims`) |
| `resolve` retorna `null`/`undefined` | `unauthorized` | `No such user` |

Inválido e expirado colapsam em uma única mensagem de propósito: o endpoint nunca
é um oráculo de validade. Precisa de um token mais estrito? `jwtAuth` também aceita `alg`, `issuer`,
`audience`, um `slot` customizado e um `header` customizado.

## 4. Emita um token com `signJwt`

A verificação precisa de algo para verificar. `signJwt` carimba `iat` e assina seus
claims; as opções de claims registrados (`subject`, `expiresInSeconds`, `issuer`, …)
sobrescrevem chaves de mesmo nome. O exemplo expõe uma rota mínima para que a suíte de testes (e
você, com `curl`) possa obter um token real sem ferramentas externas:

```ts
// src/modules/auth/auth.route.ts
import { signJwt } from 'katajs/jwt'

import { JWT_SECRET, TOKEN_TTL_SECONDS } from '../../config'
import { defineRoute } from '../../context'
import { TokenRequestSchema, TokenResponseSchema } from './auth.schema'

export const mintTokenRoute = defineRoute({
  method: 'POST',
  path: '/auth/token',
  input: { body: TokenRequestSchema }, // { id, name, email }
  output: TokenResponseSchema, // { token }
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

A chave de assinatura é compartilhada pela rota que emite e pelo middleware que
verifica — se elas discordarem, todo token falha. Um default de dev mantém o exemplo zero-config; um
app real precisa fornecer `JWT_SECRET` a partir do ambiente e nunca enviar o
fallback:

```ts
// src/config.ts
export const JWT_SECRET = process.env['JWT_SECRET'] ?? 'dev-secret'
export const TOKEN_TTL_SECONDS = 60 * 60
```

> Esta rota `/auth/token` confia em quem a chama, então ela **não** é como você
> autentica usuários reais — um endpoint de produção verifica credenciais (ou um
> código OAuth) antes de assinar. Ela existe aqui para tornar o ciclo emitir → verificar
> executável de ponta a ponta.

## 5. Consuma-o em uma rota

Uma rota adere ao middleware via `use: [...]`. A ordem importa — middlewares
rodam da esquerda para a direita. Uma vez que `requireUser` tenha rodado, `c.get('currentUser')` retorna um
`User` de forma síncrona dentro do handler.

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'
import { requireUser } from '../../middlewares/auth'

import { UserSchema } from './users.schema'

export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser],
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'),
})
```

Retornar o valor do usuário (não um `Response`) significa que a Kata o valida contra
`output` (`UserSchema`) antes de enviá-lo — veja [errors.md](./errors.md).

## Comportamento sobre o fio

Isto espelha os casos de `GET /me` afirmados em
[`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl):

```http
POST /auth/token        {"id":"42","name":"Ada","email":"ada@example.com"}
→ 200  { "token": "eyJhbGc…" }

GET /me
→ 401  { "error": "unauthorized", "message": "Missing bearer token" }

GET /me
Authorization: Bearer eyJhbGc…
→ 200  { "id": "42", "name": "Ada", "email": "ada@example.com" }

GET /me
Authorization: Bearer not-a-real-jwt
→ 401  { "error": "unauthorized", "message": "Invalid or expired token" }
```

## 6. Autorize: guards que dependem do usuário

A autenticação prova _quem_ você é; a **autorização** decide _o que você pode fazer_.
Um guard lê um scoped slot que ele não provê — desde que um middleware mais cedo
na cadeia `use:` o tenha provido — e rejeita com um **403** quando seu predicado
diz não. Sua lista `provides` é vazia. A **ordem no array `use:` é o
contrato**: o guard precisa vir _depois_ do middleware de auth que preenche o slot.

A Kata entrega três guard handlers em `katajs/jwt`:

- `requireRole(role | roles[])` — permite somente quando o `role` do valor do slot é (um dos) `role`.
- `requireClaim(key, expected | predicate)` — permite somente quando um claim corresponde.
- `guard({ authorize })` — a forma geral; forneça qualquer predicado sobre o valor do slot.

Cada um carrega um `role`/claim no slot, então estenda seus claims (e `User`) com
o campo no qual você faz o guard:

```ts
// users.schema.ts — adicione um role tanto aos claims quanto ao User
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['user', 'admin']),
})
```

```ts
// em uma rota — requireUser PRECISA vir antes do guard
import { requireRole } from 'katajs/jwt'

export const adminRoute = defineRoute({
  method: 'GET',
  path: '/admin/metrics',
  use: [requireUser, requireRole('admin')], // 401 se não autenticado, 403 se não for admin
  input: {},
  output: MetricsSchema,
  handler: async (c) => collectMetrics(),
})
```

```http
GET /admin/metrics
Authorization: Bearer <token for a non-admin>
→ 403  { "error": "forbidden", "message": "Insufficient permissions" }
```

Para qualquer coisa que o baseado em role não consiga expressar, desça para `guard` com um predicado customizado
(ele pode ser `async` e recebe o contexto do middleware como segundo argumento):

```ts
import { guard } from 'katajs/jwt'

// Apenas o dono do recurso pode lê-lo.
const requireOwner = defineMiddleware({
  provides: [] as const,
  handler: guard<AppRegistry, User>({
    authorize: (user, c) => user.id === c.raw.req.param('id'),
    code: 'forbidden',
    message: 'Not your resource',
  }),
})
```

## Por que scoped em vez de uma variável de nível de módulo

- **Isolamento por requisição.** Um global de módulo vazaria o usuário de uma
  requisição para a próxima sob concorrência. Um scoped slot é armazenado por requisição.
- **Verificável estaticamente.** Como toda leitura é `c.get('currentUser')` e
  todo provedor declara `provides: ['currentUser']`, o harness consegue provar que
  nenhuma rota lê `currentUser` sem um middleware de auth em sua cadeia — a
  regra `kata/scoped-slot-not-provided` (ADR-0004, _Companion rules_).
- **Falha explícita.** `jwtAuth` curto-circuita com um `Response` em qualquer
  falha; ele não pode passar adiante e deixar o slot sem preenchimento.

## Pegadinhas

- **Ler um scoped slot sem provedor lança em runtime.** Se um handler
  chama `c.get('currentUser')` mas nenhum middleware em `use:` o definiu, a Kata lança
  `kata: scoped slot 'currentUser' read before being set. Did the providing
  middleware run?`. A regra de lint `kata/scoped-slot-not-provided` transforma isso em
  um erro de build.
- **`c.set` e `c.header` são exclusivos de middleware.** O contexto do route handler tem
  `c.get`, `c.input`, `c.json`, `c.error` e `c.raw` — mas não tem `set` (handlers
  consomem slots, eles não os preenchem) nem o atalho `header` (leia headers via
  um schema `input.headers`, ou `c.raw.req.header(...)`).
- **Mantenha o secret fora do tipo do slot.** `resolve` decide o que cai no
  slot; retorne seu `User`, nunca o token bruto ou o secret.
- **Não leia scoped slots no carregamento do módulo.** Eles só existem dentro de uma requisição
  (imposto pela regra `kata/scoped-read-outside-request`).
