---
title: '@katajs-framework/core/jwt'
description: Referência de assinaturas para @katajs-framework/core/jwt — signJwt, verifyJwt, jwtAuth, os guards e todos os tipos exportados.
---

# @katajs-framework/core/jwt

`@katajs-framework/core/jwt` é o subcaminho de auth do pacote `@katajs-framework/core`. Ele entrega as primitivas
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
} from '@katajs-framework/core/jwt'
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

`FieldIssue` é o export central de `@katajs-framework/core` reutilizado aqui (`{ path, message, code,
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
import { jwtAuth } from '@katajs-framework/core/jwt'

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
guard<R extends Registry, const S extends ScopedKeys<R> = 'currentUser'>(
  options: GuardOptions<R, S>,
): Middleware<R>['handler']
```

`S` é a *chave* do slot, não o tipo do valor — o parâmetro de `authorize` é
derivado de `R` via `SlotValue<R, S>`, a mesma projeção que `RouteContext.get`
usa. Você fornece `R` explicitamente; `S` é inferido de `options.slot` (ou usa
o padrão `'currentUser'`), nunca passado como um segundo argumento de tipo
explícito.

```ts
type GuardOptions<R extends Registry, S extends ScopedKeys<R> = 'currentUser'> = {
  slot?: S
  authorize: (claims: SlotValue<R, S>, c: MiddlewareContext<R>) => boolean | Promise<boolean>
  code?: string
  message?: string
}
```

| Campo | Tipo | Efeito |
| --- | --- | --- |
| `authorize` | `(claims, c) => boolean \| Promise<boolean>` | Predicado sobre o valor do slot. Retorne `false` para rejeitar com 403 (obrigatório). |
| `slot?` | `S extends ScopedKeys<R>` | Slot que o guard lê. Padrão `'currentUser'`. Precisa ser uma chave scoped real de `R`. |
| `code?` | `string` | Código `error` do envelope 403. Padrão `'forbidden'`. |
| `message?` | `string` | Mensagem do envelope 403. Padrão `'Insufficient permissions'`. |

```ts
import { guard } from '@katajs-framework/core/jwt'

const requireOwner = defineMiddleware({
  provides: [] as const,
  handler: guard<AppRegistry>({
    authorize: (user, c) => user.id === c.raw.req.param('id'),
    code: 'forbidden',
    message: 'Not your resource',
  }),
})
```

::: warning Mudança incompatível (#211)
`slot` era uma `string` pura e `C` (agora `S`) uma asserção não verificada do
tipo do valor do slot — `guard<R, Membership>({ slot: 'currentOrg', authorize:
(m) => m.role === 'owner' })` compilava mesmo com `currentOrg` guardando um
`Org`, e respondia 403 a toda requisição em runtime. `slot` agora é `S extends
ScopedKeys<R>` e o tipo dos claims de `authorize` é derivado de `R`, então um
par `slot` / predicado errado agora é um erro de `tsc`. Remova qualquer segundo
argumento de tipo explícito que você passava — ele não significa mais "o tipo
dos claims", e o uso antigo não satisfaz a nova constraint `ScopedKeys<R>`.
:::

### `requireRole`

```ts
requireRole<R extends Registry, const S extends ScopedKeys<R> = 'currentUser'>(
  role: string | readonly string[],
  options?: { slot?: S },
): Middleware<R>['handler']
```

Açúcar sobre `guard`. Permite somente quando o `role` do valor do slot é (um dos)
`role`. Lê o slot padrão `currentUser` (sobrescreva via `options.slot`, inferido
da mesma forma que o de `guard`) e rejeita com o envelope 403 `forbidden` padrão.
Retorna um handler puro, assim como `guard` — envolva com `defineMiddleware({
provides: [] as const, handler })`.

```ts
// um único role
handler: requireRole<AppRegistry>('admin')

// múltiplos roles
handler: requireRole<AppRegistry>(['admin', 'editor'])
```

### `requireClaim`

```ts
requireClaim<R extends Registry, const S extends ScopedKeys<R> = 'currentUser'>(
  key: string,
  expected: unknown | ((value: unknown) => boolean),
  options?: { slot?: S },
): Middleware<R>['handler']
```

Açúcar sobre `guard`. Permite somente quando a claim do valor do slot em `key`
corresponde a `expected` — por igualdade estrita, ou por predicado quando
`expected` é uma função. Lê o slot padrão `currentUser` (sobrescreva via
`options.slot`, inferido da mesma forma que o de `guard`).

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
| `GuardOptions<R, S>` | Opções para `guard`. |

`Registry`, `Middleware`, `MiddlewareContext`, `ScopedKeys`, `SlotValue` e
`FieldIssue` são tipos centrais reutilizados nestas assinaturas; eles são
exportados de `@katajs-framework/core`, não de `@katajs-framework/core/jwt`.

::: info Você é dono do fluxo de login
`@katajs-framework/core/jwt` te dá assinatura, verificação, o middleware de auth e os guards. Hash
de senha, o store de usuários, a rota de login, refresh tokens e JWKS / OIDC
remoto ficam além desta costura — eles são seus. Veja o
[Cookbook de autenticação](/pt/cookbook/auth) e o [ADR-0013](/adr/0013-jwt-delivery).
:::

## Veja também

- [Auth JWT](/pt/guide/jwt) — o guia narrativo que esta página complementa.
- [Cookbook de autenticação](/pt/cookbook/auth) — o passo a passo de login ponta a ponta.
- [defineMiddleware](/pt/reference/define-middleware) — `provides`, o handler, curto-circuito.
- [Erros](/pt/guide/errors) — o envelope de erro unificado que os guards e o `jwtAuth` renderizam.
- [Referência da API](/pt/reference/) — todos os exports públicos em `@katajs-framework/core`, `@katajs-framework/core/jwt` e `@katajs-framework/core/node`.
- [ADR-0013](/adr/0013-jwt-delivery) — por que `hono/jwt`, por que um subcaminho, a fronteira BYO.
