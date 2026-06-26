---
title: Middlewares nativos
description: Assinaturas exatas, opções e padrões dos middlewares first-party do kata — cors, secureHeaders, bodyLimit — e a constante do header request-id.
---

# Middlewares nativos

Três middlewares first-party vêm do core entry do `katajs`: `cors`,
`secureHeaders` e `bodyLimit`. Cada um é uma factory `Middleware<R>` que você
encaixa na cadeia `use:` de uma route ou na cadeia `middlewares` do app. Cada um
declara `provides: []` — não preenche nenhum scoped slot — e apenas define
response headers ou rejeita a requisição; nenhum toca no response body.

A correlação de requisições (`x-request-id`) **não** é um middleware. É embutida
no runtime e se aplica a toda resposta incondicionalmente. Veja
[Request id](#request-id) abaixo.

Para onde eles rodam, a ordenação em relação ao `use:` da route e a ressalva do
preflight de CORS, veja [Middleware no nível do app](/pt/guide/app-middleware).
Esta página é a referência de assinaturas.

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'
```

::: info Os três são opt-in
Nenhum deles roda a menos que você os adicione. Um `createApp` novo não aplica
política de CORS, nenhum header de segurança e nenhum limite de tamanho de body.
O template do `init` e o app `examples/hello` adicionam os três no nível do app —
copie isso como sua baseline.
:::

## `cors`

Um wrapper fino sobre o `cors` do Hono, moldado como um `Middleware<R>` do kata.

```ts
function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R>
```

`CorsOptions` é `NonNullable<Parameters<typeof honoCors>[0]>` — espelha exatamente
as opções de CORS do Hono: `origin`, `allowMethods`, `allowHeaders`,
`exposeHeaders`, `maxAge` e `credentials`. O kata não adiciona opções próprias e
não aplica padrões além dos do Hono. Veja a
[documentação de CORS do Hono](https://hono.dev/docs/middleware/builtin/cors)
para a semântica completa das opções.

```ts
import { cors } from 'katajs'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users],
  middlewares: [cors({ origin: 'https://app.example.com', credentials: true })],
})
```

Chamado sem argumento, `cors()` passa `undefined` ao Hono — a política padrão do
próprio Hono se aplica (`Access-Control-Allow-Origin: *`).

::: warning O preflight não é respondido por uma cadeia `use:` / global
O kata registra um handler apenas para o método declarado de uma route e não tem
route `OPTIONS` implícita, então um preflight de navegador (`OPTIONS`) nunca é
correspondido. `cors()` ainda define os headers `Access-Control-Allow-*` na
resposta *real*, mas não responde ao preflight. Para tratamento completo do
preflight, aplique CORS como um middleware nativo do Hono no app retornado por
`createApp` — `app.use('*', honoCors(...))`.
Veja [Tratando o preflight de CORS](/pt/guide/app-middleware#handling-cors-preflight).
:::

## `secureHeaders`

Um wrapper fino sobre o `secureHeaders` do Hono, moldado como um `Middleware<R>`
do kata.

```ts
function secureHeaders<R extends Registry = Registry>(
  options?: SecureHeadersOptions,
): Middleware<R>
```

`SecureHeadersOptions` é `NonNullable<Parameters<typeof honoSecureHeaders>[0]>` —
espelha as opções de secure-headers do Hono: `xFrameOptions`,
`strictTransportSecurity`, `contentSecurityPolicy`, `referrerPolicy` e o
restante. Passe `false` para um header individual para desabilitá-lo. Veja a
[documentação de secure-headers do Hono](https://hono.dev/docs/middleware/builtin/secure-headers).

Sem opções, `secureHeaders()` aplica a baseline endurecida do Hono —
`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Strict-Transport-Security` e mais — e remove `X-Powered-By`.

```ts
import { secureHeaders } from 'katajs'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users],
  middlewares: [secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"] } })],
})
```

## `bodyLimit`

Um wrapper fino sobre o `bodyLimit` do Hono, moldado como um `Middleware<R>` do
kata. O runtime do kata lê o request body via `c.req.json()` sem guarda de
tamanho, então adicione `bodyLimit` para rejeitar payloads superdimensionados
antes que sejam carregados em buffer e parseados. O limite é imposto via o header
`Content-Length` (caminho rápido) e, quando não há `Content-Length`, medindo o
body em streaming.

```ts
function bodyLimit<R extends Registry = Registry>(
  options?: BodyLimitOptions,
): Middleware<R>
```

`BodyLimitOptions` é um tipo próprio do kata — não repassa o do Hono:

```ts
type BodyLimitOptions = {
  /** Tamanho máximo do request body em bytes. Default: DEFAULT_MAX_BODY_SIZE (1 MiB). */
  maxSize?: number
  /**
   * Resposta retornada quando o limite é excedido. Default: HTTP 413 com o
   * error envelope unificado do kata.
   */
  onError?: (c: Context) => Response | Promise<Response>
}
```

### Padrões

`maxSize` usa por padrão `DEFAULT_MAX_BODY_SIZE`, exportado de `katajs`:

```ts
import { DEFAULT_MAX_BODY_SIZE } from 'katajs'

DEFAULT_MAX_BODY_SIZE // 1024 * 1024 — 1 MiB
```

Quando o limite é excedido e você não fornece `onError`, o padrão retorna HTTP
`413` com o error envelope unificado do kata
([ADR-0008](/adr/0008-unified-error-response-envelope)):

```json
{
  "error": "payload_too_large",
  "message": "Request body exceeds the maximum allowed size"
}
```

```ts
import { bodyLimit } from 'katajs'

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({
  modules: [users],
  middlewares: [bodyLimit({ maxSize: 8 * 1024 })], // 8 KiB
})
```

Forneça `onError` para customizar a rejeição. Ele recebe o `Context` cru do Hono
e deve retornar um `Response`:

```ts
import { bodyLimit } from 'katajs'

bodyLimit({
  maxSize: 8 * 1024,
  onError: (c) => c.json({ error: 'too_big' }, 413),
})
```

## Uso em `createApp`

A mesma factory funciona na cadeia `use:` de uma route e na cadeia `middlewares`
do app. Como cada uma declara `provides: []`, nenhuma route precisa listá-la. O
app `examples/hello` aplica os três no nível do app:

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp } from './context'
import * as users from './modules/users/users.route'
import * as echo from './modules/echo/echo.route'

const app = createApp({
  modules: [users, echo],
  // Roda antes do `use:` próprio de cada route.
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

A cadeia global roda **antes** do `use:` próprio de cada route. Para a tabela
completa de ordenação e as regras de short-circuit / scoped slot, veja
[Middleware no nível do app](/pt/guide/app-middleware).

::: tip Por-route em vez de global
Uma preocupação que pertence a uma única route fica no `use:` daquela route:

```ts
defineRoute({
  method: 'POST',
  path: '/upload',
  use: [bodyLimit({ maxSize: 5 * 1024 * 1024 })], // 5 MiB, somente esta route
  input: { body: UploadBody },
  output: UploadResult,
  handler: (c) => /* ... */,
})
```
:::

## Por que precisam de um wrapper

Esses três são middlewares comuns do Hono adaptados ao modelo de resposta do
kata. O kata monta sua resposta no *fim* da cadeia de uma route e a retorna
desacoplada de `c.res`, então um middleware do Hono que define headers *depois*
do seu próprio `next()` — como o `secureHeaders` — de outra forma seria
descartado. O adapter interno roda o middleware do Hono até o fim primeiro (com
um `next` inerte) para que todo header que ele define esteja em `c.res` antes de o
kata fazer o snapshot da resposta, e então continua a cadeia do kata. Se o
middleware encapsulado fizer short-circuit com um `Response` (um `413`, um
preflight de CORS `204`), essa resposta é retornada e a cadeia para.

Isso torna o adapter correto para middleware que **apenas define response headers
ou rejeita uma requisição** — não para transformadores de resposta (compressão,
ETag) que precisam observar o body final. O adapter é interno: para encapsular
seu próprio middleware do Hono você recorre a
[`defineMiddleware`](/pt/reference/define-middleware) e escreve no scoped store
com `c.set`. Veja [Middleware no nível do app](/pt/guide/app-middleware) para a
explicação completa.

## Request id

O kata atribui um id de correlação a toda requisição — não há middleware para
adicionar e não há opt-out. O runtime reutiliza um header `x-request-id` de
entrada bem formado (de modo que um id cunhado em um proxy de borda flui inalterado)
e, caso contrário, gera um UUID novo. Um valor de entrada malformado ou
superdimensionado é ignorado em favor de um id gerado. O id resolvido é ecoado no
response header `x-request-id` de todo desfecho — incluindo short-circuits e erros
`5xx` — e está disponível como `c.requestId` dentro de middleware e handlers.

Apenas a constante do nome do header é exportada:

```ts
import { REQUEST_ID_HEADER } from 'katajs'

REQUEST_ID_HEADER // 'x-request-id'
```

::: info Validação de ids de entrada
Um `x-request-id` de entrada só é confiável se corresponder a `^[\w.:-]{1,200}$`
após o trim — suficiente para UUIDs e trace ids do W3C, mantendo de fora
newlines e outros caracteres de controle (o vetor de injeção em header e log).
Qualquer outra coisa é substituída por um UUID gerado.
:::

## Exports

Tudo nesta página vem do core entry do `katajs`:

| Export | Tipo | Notas |
| --- | --- | --- |
| `cors` | factory `Middleware<R>` | encapsula `cors` do Hono |
| `secureHeaders` | factory `Middleware<R>` | encapsula `secureHeaders` do Hono |
| `bodyLimit` | factory `Middleware<R>` | encapsula `bodyLimit` do Hono |
| `DEFAULT_MAX_BODY_SIZE` | `number` | `1024 * 1024` (1 MiB) |
| `CorsOptions` | type | espelha as opções de CORS do Hono |
| `SecureHeadersOptions` | type | espelha as opções de secure-headers do Hono |
| `BodyLimitOptions` | type | `{ maxSize?, onError? }` |
| `REQUEST_ID_HEADER` | `string` | `'x-request-id'` |

## Veja também

- [Middleware no nível do app](/pt/guide/app-middleware) — a cadeia
  `middlewares`, a ordenação e o padrão de preflight de CORS.
- [Middleware](/pt/guide/middleware) — o contrato `Middleware<R>` e o
  preenchimento de scoped slot para middleware que você escreve.
- [`defineMiddleware`](/pt/reference/define-middleware) — defina seu próprio middleware.
- [JWT auth](/pt/reference/jwt) — o middleware `jwtAuth` de `katajs/jwt`.
