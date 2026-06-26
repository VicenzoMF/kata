---
title: kata/jwt
description: Referência de assinaturas para kata/jwt — signJwt, verifyJwt, jwtAuth, os guards e todos os tipos exportados.
---

# kata/jwt

`kata/jwt` é o subcaminho de auth do pacote `kata`. Ele entrega as primitivas
JWT stateless — `signJwt` / `verifyJwt` — mais o middleware `jwtAuth` ciente do
Kata e os guards de autorização. É o único módulo que importa `hono/jwt`, então
não adiciona nenhuma dependência além do peer `hono` ([ADR-0013](/adr/0013-jwt-delivery)).

```ts
import {
  signJwt,
  verifyJwt,
  jwtAuth,
  guard,
  requireRole,
  requireClaim,
} from 'katajs/jwt'
```

Tudo é uma função. Um token inválido ou expirado é um desfecho esperado, não uma
exceção: `verifyJwt` retorna um `Result` discriminado, e `jwtAuth` renderiza o
envelope de erro unificado em vez de lançar.

Esta página é a referência de assinaturas. Para a narrativa — declarar o schema
de claims, conectar o `jwtAuth` em um scoped slot, ordenar guards no `use:` —
veja [Auth JWT](/pt/guide/jwt). Para o padrão de login ponta a ponta, veja o
[Cookbook de autenticação](/pt/cookbook/auth).

## `signJwt`

```ts
signJwt(claims: Record<string, unknown>, options: SignOptions): Promise<string>
```

Assina um objeto de claims em um JWT compacto — um wrapper funcional fino sobre o
`sign` do `hono/jwt`. Ele sempre carimba `iat` (issued-at = agora). As claims
registradas derivadas de `options` (`exp`, `nbf`, `iss`, `aud`, `sub`)
**sobrescrevem** qualquer chave de mesmo nome em `claims`.

`signJwt` rejeita apenas com uma chave ou algoritmo mal configurado — um erro de
programador sem ramo tratado pelo chamador. Essa é a assimetria deliberada com
`verifyJwt`, que retorna um `Result`.

### `SignOptions`

```ts
type SignOptions = {
  secret: string
  alg?: JwtAlgorithm
  expiresInSeconds?: number
  notBeforeSeconds?: number
  issuer?: string
  audience?: string
  subject?: string
}
```

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `secret` | `string` | Chave de assinatura (obrigatório). |
| `alg?` | `JwtAlgorithm` | Algoritmo de assinatura. Padrão `'HS256'`. |
| `expiresInSeconds?` | `number` | Define `exp = iat + expiresInSeconds`. |
| `notBeforeSeconds?` | `number` | Define `nbf = iat + notBeforeSeconds`. |
| `issuer?` | `string` | Define a claim `iss`. |
| `audience?` | `string` | Define a claim `aud`. |
| `subject?` | `string` | Define a claim `sub`. |

```ts
const token = await signJwt(
  { name: 'Ada', email: 'ada@example.com' },
  { secret: JWT_SECRET, subject: 'u1', expiresInSeconds: 900 },
)
```

## `verifyJwt`

```ts
verifyJwt<S extends z.ZodTypeAny>(
  token: string,
  options: VerifyOptions<S>,
): Promise<JwtVerifyResult<z.infer<S>>>
```

Verifica a assinatura e as claims de tempo (e `iss` / `aud` quando fornecidas)
via `hono/jwt`, depois faz o parse do payload decodificado através de
`options.claims`. Retorna um `Result` discriminado — nunca lança.

Uma falha de assinatura, estrutura, algoritmo, `iss`, `aud` ou not-before colapsa
para `invalid_token`; um token expirado para `expired`; um payload que falha no
schema Zod para `claims_mismatch` (carregando `issues` estruturado). O colapso é
deliberado: `verifyJwt` nunca é um oráculo de validade.

Você raramente chama `verifyJwt` diretamente no código de rota — `jwtAuth` o
encapsula. Recorra a ele para verificar um token fora da cadeia de middleware da
requisição (um job em background, um upgrade de websocket, um CLI).

### `VerifyOptions`

```ts
type VerifyOptions<S extends z.ZodTypeAny> = {
  secret: string
  claims: S
  alg?: JwtAlgorithm
  issuer?: string
  audience?: string
}
```

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `secret` | `string` | Chave de verificação (obrigatório). |
| `claims` | `S extends z.ZodTypeAny` | Schema que o payload decodificado deve satisfazer. Seu `z.infer` é o tipo de sucesso (obrigatório). |
| `alg?` | `JwtAlgorithm` | Algoritmo de assinatura esperado. Padrão `'HS256'`. |
| `issuer?` | `string` | Quando definido, exige esta claim `iss`. |
| `audience?` | `string` | Quando definido, exige esta claim `aud`. |

### Formatos de Result e de erro

```ts
type JwtVerifyResult<T> =
  | { readonly ok: true; readonly claims: T }
  | { readonly ok: false; readonly error: JwtError }

type JwtErrorCode = 'invalid_token' | 'expired' | 'claims_mismatch'

type JwtError = {
  readonly code: JwtErrorCode
  readonly message: string
  // presente apenas quando code === 'claims_mismatch' — o mesmo formato FieldIssue[]
  // do envelope de erro de validação
  readonly issues?: FieldIssue[]
}
```

```ts
const result = await verifyJwt(token, {
  secret: JWT_SECRET,
  claims: UserClaimsSchema,
})

if (result.ok) {
  result.claims // tipado como z.infer<typeof UserClaimsSchema>
} else {
  result.error.code // 'invalid_token' | 'expired' | 'claims_mismatch'
}
```

`FieldIssue` é o export central de `kata` reutilizado aqui (`{ path, message, code,
expected?, received? }`); veja [Erros](/pt/guide/errors).

## `jwtAuth`

```ts
jwtAuth<R extends Registry, S extends z.ZodTypeAny>(
  options: JwtAuthOptions<S, R>,
): Middleware<R>['handler']
```

Constrói um **handler** de middleware que autentica uma requisição via JWT. Ele
lê `Authorization: Bearer <token>` (header configurável), executa `verifyJwt` e,
em caso de sucesso, escreve as claims validadas — ou, com `resolve`, o valor que
você retornar — em um scoped slot. A correspondência do esquema bearer é
case-insensitive (RFC 7235).

`jwtAuth` retorna **apenas o handler**. Encapsule-o você mesmo com
`defineMiddleware({ provides: [slot] as const, handler })` para que o literal de
`provides` permaneça no ponto de chamada onde o sistema de tipos e a regra de
lint `kata/scoped-slot-not-provided` podem lê-lo. `R` não é inferível a partir de
`options`; a participação do slot em `ScopedKeys<R>` e o fato de seu tipo
declarado corresponder a `z.infer<S>` (ou ao retorno de `resolve`) são impostos
ali, não por esta assinatura (ADR-0013 §4).

```ts
// src/middlewares/auth.ts
import { jwtAuth } from 'katajs/jwt'

import { JWT_SECRET } from '../config'
import { defineMiddleware } from '../context'
import { UserClaimsSchema } from '../modules/users/users.schema'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: jwtAuth({ secret: JWT_SECRET, claims: UserClaimsSchema }),
})
```

### `JwtAuthOptions`

```ts
type JwtAuthOptions<S extends z.ZodTypeAny, R extends Registry = Registry> = {
  secret: string
  claims: S
  slot?: string
  alg?: JwtAlgorithm
  issuer?: string
  audience?: string
  header?: string
  resolve?: (claims: z.infer<S>, c: MiddlewareContext<R>) => Promise<unknown> | unknown
}
```

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `secret` | `string` | Chave de verificação (obrigatório). |
| `claims` | `S extends z.ZodTypeAny` | Schema que o payload deve satisfazer. Seu `z.infer` torna-se o valor do slot, a menos que `resolve` o mapeie adiante (obrigatório). |
| `slot?` | `string` | Scoped slot a ser preenchido. Padrão `'currentUser'`. |
| `alg?` | `JwtAlgorithm` | Algoritmo esperado. Padrão `'HS256'`. |
| `issuer?` | `string` | Quando definido, exige esta claim `iss`. |
| `audience?` | `string` | Quando definido, exige esta claim `aud`. |
| `header?` | `string` | Header da requisição de onde ler o token bearer. Padrão `'authorization'`. |
| `resolve?` | `(claims, c) => Promise<unknown> \| unknown` | Mapeia as claims validadas para o valor escrito no slot. Veja abaixo. |

### O hook `resolve`

Sem `resolve`, o slot guarda as **claims validadas pelo Zod** literalmente. Com
`resolve`, ele guarda o que você retornar — e o tipo do slot é esse valor, não
`z.infer<S>`. Ele roda após a validação das claims, recebe as claims validadas e
o contexto do middleware, e pode ser `async`:

```ts
handler: jwtAuth({
  secret: JWT_SECRET,
  claims: IdClaimsSchema, // ex.: { sub: z.string() }
  resolve: async (claims, c) => c.get('db').users.findById(claims.sub),
})
```

Retornar `null` ou `undefined` significa "token válido, mas usuário inexistente"
e renderiza um **401** — distinto de um 403, que é uma decisão de autorização que
um guard toma.

### Falhas de autenticação (401)

Toda falha curto-circuita a cadeia com o envelope de erro unificado como um
**401**; o handler nunca roda.

| Situação | `error` | `message` |
| --- | --- | --- |
| header `Authorization` ausente / malformado | `unauthorized` | `Missing bearer token` |
| assinatura inválida, alg errado, divergência de `iss` / `aud` / `nbf`, expirado | `unauthorized` | `Invalid or expired token` |
| payload falha em `claims` | `unauthorized` | `Token claims did not match` (com `issues.claims`) |
| `resolve` retorna `null` / `undefined` | `unauthorized` | `No such user` |

Inválido e expirado colapsam para uma única mensagem de propósito — sem oráculo
de validade.

## Guards

Um guard é uma camada de **autorização** sobre o slot que `jwtAuth` preencheu.
Ele lê um slot já provido e rejeita com um envelope **403** quando seu predicado
diz não; caso contrário, chama `next()`. Cada guard retorna **apenas o handler** e
não provê nada, então encapsule-o com `defineMiddleware({ provides: [] as const,
handler })` e posicione-o **depois** do middleware de auth no array `use:` da
rota.

### `guard`

```ts
guard<R extends Registry, C = unknown>(
  options: GuardOptions<R, C>,
): Middleware<R>['handler']
```

A forma geral. `C` é a sua asserção do tipo do valor do slot.

```ts
type GuardOptions<R extends Registry, C = unknown> = {
  slot?: string
  authorize: (claims: C, c: MiddlewareContext<R>) => boolean | Promise<boolean>
  code?: string
  message?: string
}
```

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `authorize` | `(claims, c) => boolean \| Promise<boolean>` | Predicado sobre o valor do slot. Retorne `false` para rejeitar com 403 (obrigatório). |
| `slot?` | `string` | Slot que o guard lê. Padrão `'currentUser'`. |
| `code?` | `string` | Código `error` do envelope 403. Padrão `'forbidden'`. |
| `message?` | `string` | Mensagem do envelope 403. Padrão `'Insufficient permissions'`. |

```ts
import { guard } from 'katajs/jwt'

const requireOwner = defineMiddleware({
  provides: [] as const,
  handler: guard<AppRegistry, User>({
    authorize: (user, c) => user.id === c.raw.req.param('id'),
    code: 'forbidden',
    message: 'Not your resource',
  }),
})
```

### `requireRole`

```ts
requireRole<R extends Registry>(
  role: string | readonly string[],
  options?: { slot?: string },
): Middleware<R>['handler']
```

Açúcar sobre `guard`. Permite somente quando o `role` do valor do slot é (um dos)
`role`. Lê o slot padrão `currentUser` (sobrescreva via `options.slot`) e rejeita
com o envelope 403 `forbidden` padrão.

```ts
use: [requireUser, requireRole('admin')]
use: [requireUser, requireRole(['admin', 'editor'])]
```

### `requireClaim`

```ts
requireClaim<R extends Registry, C extends Record<string, unknown> = Record<string, unknown>>(
  key: string,
  expected: unknown | ((value: unknown) => boolean),
  options?: { slot?: string },
): Middleware<R>['handler']
```

Açúcar sobre `guard`. Permite somente quando a claim do valor do slot em `key`
corresponde a `expected` — por igualdade estrita, ou por predicado quando
`expected` é uma função. Lê o slot padrão `currentUser` (sobrescreva via
`options.slot`).

```ts
// igualdade estrita
handler: requireClaim('email_verified', true)

// predicado
handler: requireClaim('plan', (v) => v === 'pro' || v === 'team')
```

## Tipos exportados

| Tipo | Formato |
| --- | --- |
| `JwtAlgorithm` | `'HS256' \| 'HS384' \| 'HS512' \| 'RS256' \| 'RS384' \| 'RS512' \| 'PS256' \| 'PS384' \| 'PS512' \| 'ES256' \| 'ES384' \| 'ES512' \| 'EdDSA'`. |
| `SignOptions` | Opções para `signJwt`. |
| `VerifyOptions<S>` | Opções para `verifyJwt`. |
| `JwtErrorCode` | `'invalid_token' \| 'expired' \| 'claims_mismatch'`. |
| `JwtError` | Uma falha de verificação: `{ code, message, issues? }`. |
| `JwtVerifyResult<T>` | O resultado de `verifyJwt`: `{ ok: true, claims }` ou `{ ok: false, error }`. |
| `JwtAuthOptions<S, R>` | Opções para `jwtAuth`. |
| `GuardOptions<R, C>` | Opções para `guard`. |

`Registry`, `Middleware`, `MiddlewareContext` e `FieldIssue` são tipos centrais
reutilizados nestas assinaturas; eles são exportados de `kata`, não de `kata/jwt`.

::: info Você é dono do fluxo de login
`kata/jwt` te dá assinatura, verificação, o middleware de auth e os guards. Hash
de senha, o store de usuários, a rota de login, refresh tokens e JWKS / OIDC
remoto ficam além desta costura — eles são seus. Veja o
[Cookbook de autenticação](/pt/cookbook/auth) e o [ADR-0013](/adr/0013-jwt-delivery).
:::

## Veja também

- [Auth JWT](/pt/guide/jwt) — o guia narrativo que esta página complementa.
- [Cookbook de autenticação](/pt/cookbook/auth) — o passo a passo de login ponta a ponta.
- [defineMiddleware](/pt/reference/define-middleware) — `provides`, o handler, curto-circuito.
- [Erros](/pt/guide/errors) — o envelope de erro unificado que os guards e o `jwtAuth` renderizam.
- [Referência da API](/pt/reference/) — todos os exports públicos em `kata`, `kata/jwt` e `kata/node`.
- [ADR-0013](/adr/0013-jwt-delivery) — por que `hono/jwt`, por que um subcaminho, a fronteira BYO.
