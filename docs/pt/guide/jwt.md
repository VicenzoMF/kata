---
title: Autenticação JWT
description: Autentique requisições com kata/jwt — assine e verifique tokens, preencha um scoped slot currentUser via jwtAuth e autorize com guards de role e claim.
---

# Autenticação JWT

`kata/jwt` é um subpath tree-shakeable do pacote core. Ele entrega os blocos de
construção de JWT para que você não tenha que escrever um verificador na mão:
assinar um token, verificá-lo, autenticar uma requisição em um scoped slot e
autorizar esse slot com guards. Não adiciona **nenhuma dependência nova** —
`kata/jwt` é construído sobre `hono/jwt`, e `hono` já é uma peer dependency
([ADR-0013](/adr/0013-jwt-delivery)).

```ts
import {
  signJwt,
  verifyJwt,
  jwtAuth,
  guard,
  requireRole,
  requireClaim,
} from 'kata/jwt'
```

Tudo aqui é uma função. Sem classes, sem decorators, sem container de IoC. Um
token inválido ou expirado é um resultado normal, não uma exceção — por isso o
`verifyJwt` retorna um `Result`, e o `jwtAuth` renderiza o envelope de erro
unificado em vez de lançar.

::: info O que o Kata NÃO entrega
Login, hashing de senha, o armazenamento de usuários, rotação de refresh-token,
sessões e provedores remotos de JWKS / OIDC (Auth0, Cognito, Clerk) são **seus**.
`kata/jwt` é a costura de verificar-e-autorizar; o modelo de credencial e
identidade é BYO. Veja [O que é seu](#o-que-e-seu) abaixo.
:::

## As quatro peças

| Função | Papel |
| --- | --- |
| `signJwt(claims, opts)` | assina um objeto de claims em um JWT compacto |
| `verifyJwt(token, opts)` | verifica + faz parse Zod de um token → um `Result` (nunca lança) |
| `jwtAuth(opts)` | um **handler** de middleware que autentica uma requisição e preenche um scoped slot |
| `guard(opts)` / `requireRole(...)` / `requireClaim(...)` | **handlers** de middleware que autorizam (403) |

`signJwt` e `verifyJwt` são as primitivas stateless — elas não sabem nada sobre
o context do Kata. `jwtAuth` e os guards são a camada que conhece o Kata: eles
retornam um **handler** de middleware (não um middleware completo), então você
mantém o wrapper `defineMiddleware({ provides: [...] })` no ponto de chamada,
onde o sistema de tipos e o lint conseguem lê-lo.

## Descreva os claims

Um payload de JWT é dado sem tipo até você validá-lo. Declare um schema Zod para
os claims que você espera; `jwtAuth` faz parse de todo token decodificado por
ele, de modo que um payload controlado por um atacante nunca chega a um handler
como um blob sem tipo (o tipo `any` é proibido). Schemas ficam em
`<domain>.schema.ts`.

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

// `sub` é o claim padrão de subject do JWT (o id do usuário); `name`/`email`
// seguem junto como claims extras. Claims registrados como `iat`/`exp` são
// removidos por este object schema.
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
})

export type UserClaims = z.infer<typeof UserClaimsSchema>
```

## Assine um token: `signJwt`

`signJwt` é um wrapper funcional fino sobre o `sign` do `hono/jwt`. Ele sempre
carimba `iat` (issued-at = agora). As opções de claims registrados abaixo derivam
seus claims e **sobrescrevem** qualquer chave de mesmo nome no primeiro argumento.

```ts
signJwt(claims: Record<string, unknown>, options: SignOptions): Promise<string>
```

`SignOptions`:

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `secret` | `string` | chave de assinatura (obrigatório) |
| `alg?` | `JwtAlgorithm` | algoritmo de assinatura. Padrão `'HS256'` |
| `expiresInSeconds?` | `number` | define `exp = iat + expiresInSeconds` |
| `notBeforeSeconds?` | `number` | define `nbf = iat + notBeforeSeconds` |
| `issuer?` | `string` | define o claim `iss` |
| `audience?` | `string` | define o claim `aud` |
| `subject?` | `string` | define o claim `sub` |

`JwtAlgorithm` é `HS256/384/512`, `RS256/384/512`, `PS256/384/512`,
`ES256/384/512` ou `EdDSA`.

```ts
// src/modules/auth/auth.route.ts
import { signJwt } from 'kata/jwt'

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

`signJwt` só rejeita em uma chave ou algoritmo mal configurados — um erro de
programação sem nenhum branch tratado pelo chamador. Essa é a assimetria
deliberada com `verifyJwt`, que retorna um `Result`.

::: warning Isto não é login
Essa route confia em quem a chama, então **não** é assim que você autentica
usuários reais — ela existe para que o exemplo (e sua suíte Hurl) consiga obter
um token sem ferramentas externas. Um endpoint de produção verifica as
credenciais (ou um código OAuth) **antes** de assinar. Veja [O que é seu](#o-que-e-seu).
:::

## Verifique um token: `verifyJwt`

`verifyJwt` checa a assinatura e os claims de tempo (e `iss` / `aud` quando
informados) via `hono/jwt`, depois faz parse do payload pelo seu schema de
`claims`. Ele retorna um `Result` discriminado — nunca lança.

```ts
verifyJwt<S extends z.ZodTypeAny>(
  token: string,
  options: VerifyOptions<S>,
): Promise<JwtVerifyResult<z.infer<S>>>
```

`VerifyOptions` recebe `secret`, `claims` (o schema; seu `z.infer` é o tipo de
sucesso) e os opcionais `alg` (padrão `'HS256'`), `issuer` e `audience`. Quando
`issuer` / `audience` estão definidos, o claim correspondente é obrigatório.

```ts
const result = await verifyJwt(token, {
  secret: JWT_SECRET,
  claims: UserClaimsSchema,
})

if (result.ok) {
  result.claims // UserClaims tipado
} else {
  result.error.code // 'invalid_token' | 'expired' | 'claims_mismatch'
}
```

O formato do erro:

```ts
type JwtErrorCode = 'invalid_token' | 'expired' | 'claims_mismatch'

type JwtError = {
  readonly code: JwtErrorCode
  readonly message: string
  // presente apenas em 'claims_mismatch' — o mesmo formato FieldIssue[] do
  // envelope de erro de validação
  readonly issues?: FieldIssue[]
}
```

Uma falha de assinatura, estrutura, algoritmo, `iss`, `aud` ou not-before
colapsa em `invalid_token`; um token expirado em `expired`; um payload que falha
no schema Zod em `claims_mismatch` (carregando `issues` estruturados).

Você raramente chama `verifyJwt` diretamente no código de uma route — `jwtAuth`
o envolve. Recorra a ele quando verificar um token fora da cadeia de middleware
da requisição (um background job, um upgrade de websocket, um CLI).

## Autentique uma requisição: `jwtAuth`

`jwtAuth` é a camada que conhece o Kata sobre o `verifyJwt`. Ele lê
`Authorization: Bearer <token>`, verifica e escreve o resultado em um
**scoped slot**. Ele retorna um **handler** de middleware — você é dono do
wrapper `defineMiddleware({ provides: [...] })`, então o literal `provides` fica
grepável e verificável pelo lint no ponto de chamada.

### 1. Declare o slot

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'kata'

import type { User } from './modules/users/users.schema'

export const k = defineContext({
  logger: singleton(logger),
  currentUser: scoped<User>(), // um User por requisição
})

export const { defineRoute, defineMiddleware, createApp } = k
export type AppRegistry = typeof k.registry
```

### 2. Conecte o `jwtAuth`

```ts
// src/middlewares/auth.ts
import { jwtAuth } from 'kata/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { type User, UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({
    secret: JWT_SECRET,
    claims: UserClaimsSchema,
    // claims → User. Em um app real: carregue do seu store por claims.sub.
    resolve: (claims): User => ({ id: claims.sub, name: claims.name, email: claims.email }),
  }),
})
```

`provides: ['currentUser'] as const` é estrutural. O `as const` preserva a chave
literal para que o sistema de tipos e a regra de lint
`kata/middleware-provides-mismatch` possam verificar que o middleware preenche
tudo o que declara. A assinatura de `jwtAuth` não consegue inferir o registry a
partir de suas opções, então é aqui que a ligação do slot é checada — exatamente
a postura que o ADR-0004 documenta para leituras scoped.

`JwtAuthOptions`:

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `secret` | `string` | chave de verificação (obrigatório) |
| `claims` | `z.ZodTypeAny` | schema que o payload deve satisfazer (obrigatório) |
| `slot?` | `string` | scoped slot a preencher. Padrão `'currentUser'` |
| `alg?` | `JwtAlgorithm` | algoritmo esperado. Padrão `'HS256'` |
| `issuer?` | `string` | quando definido, exige este `iss` |
| `audience?` | `string` | quando definido, exige este `aud` |
| `header?` | `string` | header de onde ler o token. Padrão `'authorization'` |
| `resolve?` | `(claims, c) => user` | mapeia claims → o valor armazenado no slot |

### O hook `resolve`

Sem `resolve`, o slot guarda os **claims validados pelo Zod** literalmente. Com
`resolve`, ele guarda o que você retornar — e o tipo do slot passa a ser esse
valor, não `z.infer<claims>`. Ele roda depois da validação dos claims e recebe o
context do middleware como segundo argumento, então pode ser `async`:

```ts
handler: jwtAuth({
  secret: JWT_SECRET,
  claims: UserClaimsSchema,
  resolve: async (claims, c) => c.get('db').users.findById(claims.sub),
})
```

Essa é a costura onde um app real carrega o usuário completo do seu store por
`claims.sub`. Retornar `null` ou `undefined` significa "token válido, mas não
existe tal usuário" e renderiza um **401** — distinto de um 403, que é uma
decisão de autorização que um guard toma.

::: tip Mantenha segredos fora do slot
`resolve` decide o que cai no slot. Retorne seu `User`; nunca o token bruto ou o
secret de assinatura.
:::

### 3. Consuma o slot em uma route

Uma route adere via `use: [...]`. Uma vez que `requireUser` tenha rodado,
`c.get('currentUser')` retorna o valor tipado de forma síncrona.

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

### Falhas de autenticação (401)

Toda falha de autenticação curto-circuita a cadeia com o envelope de erro
unificado como um **401** — o handler nunca roda:

| Situação | `error` | `message` |
| --- | --- | --- |
| header `Authorization` ausente / malformado | `unauthorized` | `Missing bearer token` |
| assinatura inválida, alg errado, expirado | `unauthorized` | `Invalid or expired token` |
| payload falha em `claims` | `unauthorized` | `Token claims did not match` (com `issues.claims`) |
| `resolve` retorna `null` / `undefined` | `unauthorized` | `No such user` |

Inválido e expirado colapsam em uma única mensagem propositalmente: o endpoint
nunca é um oráculo de validade.

```http
GET /me
→ 401  { "error": "unauthorized", "message": "Missing bearer token" }

GET /me
Authorization: Bearer eyJhbGc…
→ 200  { "id": "42", "name": "Ada", "email": "ada@example.com" }

GET /me
Authorization: Bearer not-a-real-jwt
→ 401  { "error": "unauthorized", "message": "Invalid or expired token" }
```

## Autorize: guards (403)

A autenticação prova _quem_ você é; a autorização decide _o que você pode fazer_.
Um guard lê um scoped slot que ele **não** provê e rejeita com um **403** quando
seu predicado diz não. Sua lista `provides` é vazia, então conecte-o com
`provides: [] as const`. A ordem no array `use:` é o contrato: o guard precisa vir
**depois** do middleware que preenche o slot.

```ts
// em uma route — requireUser PRECISA vir antes do guard
import { requireRole } from 'kata/jwt'

export const adminRoute = defineRoute({
  method: 'GET',
  path: '/admin/metrics',
  use: [requireUser, requireRole('admin')], // 401 se não autenticado, 403 se não for admin
  input: {},
  output: MetricsSchema,
  handler: async (c) => collectMetrics(),
})
```

Faça o guard sobre um campo, então estenda seus claims (e o tipo do slot) com ele:

```ts
export const UserClaimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['user', 'admin']),
})
```

### `requireRole`

```ts
requireRole(role: string | readonly string[], options?: { slot?: string })
```

Permite apenas quando o `role` do valor do slot é (um dos) `role`. Lê o slot
padrão `currentUser`. Um não-admin recebe:

```http
GET /admin/metrics
Authorization: Bearer <token for a non-admin>
→ 403  { "error": "forbidden", "message": "Insufficient permissions" }
```

### `requireClaim`

```ts
requireClaim(
  key: string,
  expected: unknown | ((value: unknown) => boolean),
  options?: { slot?: string },
)
```

Permite apenas quando o claim do valor do slot em `key` casa com `expected` — por
igualdade estrita, ou por predicado quando `expected` é uma função.

```ts
import { requireClaim } from 'kata/jwt'

// exige um email verificado
const requireVerified = defineMiddleware({
  provides: [] as const,
  handler: requireClaim('email_verified', true),
})

// ou com um predicado
const requirePaidPlan = defineMiddleware({
  provides: [] as const,
  handler: requireClaim('plan', (v) => v === 'pro' || v === 'team'),
})
```

### `guard`

A forma geral. Forneça qualquer predicado sobre o valor do slot; ele pode ser
`async` e recebe o context do middleware como segundo argumento.

```ts
guard<R, C>(options: GuardOptions<R, C>)
```

`GuardOptions`: `authorize` (o predicado, obrigatório), `slot?` (padrão
`'currentUser'`), `code?` (padrão `'forbidden'`) e `message?` (padrão
`'Insufficient permissions'`).

```ts
import { guard } from 'kata/jwt'

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

`requireRole` e `requireClaim` são açúcar fino sobre `guard`.

## O que é seu

`kata/jwt` para deliberadamente na fronteira de verificar-e-autorizar. O modelo
de credencial e identidade é BYO:

- **Login.** Verifique as credenciais (ou um código OAuth) na sua própria route,
  então chame `signJwt`. O `/auth/token` do exemplo confia em quem o chama e é um
  substituto, não um login.
- **Hashing de senha.** O Kata não entrega hashing. Use uma biblioteca confiável
  (argon2, bcrypt, scrypt) na sua camada de service.
- **Armazenamento de usuários.** `resolve` é a costura para carregar um usuário
  por `claims.sub` do seu banco de dados. O Kata não fornece um.
- **Refresh tokens.** Rotação, listas de revogação e armazenamento de
  refresh-token são seus. `signJwt` produz um access token stateless; tudo o que
  é stateful ao redor dele é código do app.
- **JWKS / OIDC remoto.** Auth0, Cognito, Clerk e verificação via JWKS ficam além
  da fronteira framework-vs-BYO da v0.3. Monte `hono/jwk` via `fromHono`, ou chame
  uma biblioteca como `jose` em um verify customizado ([ADR-0013](/adr/0013-jwt-delivery)).

## Por que um scoped slot, não um global

- **Isolamento por requisição.** Um global de módulo vazaria o usuário de uma
  requisição para a próxima sob concorrência. Um scoped slot é armazenado por
  requisição.
- **Verificável estaticamente.** Toda leitura é `c.get('currentUser')` e todo
  provedor declara `provides: ['currentUser']`, então o harness consegue provar que
  nenhuma route lê `currentUser` sem um middleware de auth em sua cadeia — a regra
  `kata/scoped-slot-not-provided`.
- **Falha explícita.** `jwtAuth` curto-circuita com um `Response` em qualquer
  falha; ele não pode passar adiante e deixar o slot sem preencher.

## Veja também

- [Receita de auth](/pt/cookbook/auth) — o passo a passo de ponta a ponta que esta página condensa.
- [Referência de `kata/jwt`](/pt/reference/jwt) — assinaturas completas.
- [Middleware & scoped slots](/pt/guide/middleware) — como `provides` e `use:` se compõem.
- [Erros](/pt/guide/errors) — o envelope de erro unificado que os guards e o `jwtAuth` renderizam.
- [ADR-0013](/adr/0013-jwt-delivery) — por que `hono/jwt`, por que um subpath, a fronteira BYO.
