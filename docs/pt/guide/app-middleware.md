---
title: Middleware no nível da aplicação
description: A cadeia de middlewares do createApp roda antes de toda rota. Declare preocupações transversais — cors, secureHeaders, bodyLimit — uma vez em vez de por rota.
---

# Middleware no nível da aplicação

Uma rota declara seu próprio middleware em `use:`. Esse é o lugar certo para uma
preocupação que pertence a uma única rota. Preocupações transversais — CORS, headers
de resposta seguros, um limite de tamanho de corpo — pertencem a *toda* rota. Copiá-las
em cada `defineRoute` é uma violação de DRY, e uma rota que você esquece de atualizar é uma rota
sem elas.

`createApp` recebe uma cadeia opcional `middlewares` para exatamente isso. Ela roda
**antes** do `use:` de cada rota.

```ts
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp } from './context'
import * as users from './modules/users/users.route'
import * as echo from './modules/echo/echo.route'

const app = createApp({
  modules: [users, echo],
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

A cadeia compartilha exatamente o mesmo contrato `Middleware<R>` que o middleware de rota usa — mesmo
pipeline em runtime, mesmo store scoped por requisição. Qualquer middleware que funcione no
`use:` de uma rota funciona aqui sem alterações. Veja a [ADR-0012](/adr/0012-app-level-middleware)
para a decisão.

## Ordenação

A cadeia efetiva de qualquer rota é a cadeia global seguida pela cadeia
própria da rota, cada uma na ordem declarada (do array):

```
effective = [...config.middlewares, ...route.use]
```

| Fase | O que roda |
| --- | --- |
| 1. Cadeia global | `config.middlewares`, em ordem — mais externa |
| 2. Cadeia da rota | `route.use`, em ordem |
| 3. Validação de input | envelope `422` em caso de falha |
| 4. Handler | `route.handler` |
| 5. Validação de output | strict/log conforme a [ADR-0009](/adr/0009-output-validation-mode) |

Esta é a cebola padrão. Um middleware global envolve todo o pipeline da rota:
o código antes do `next()` roda antes de qualquer middleware de rota, e o código
após o `next()` roda depois do handler.

Duas propriedades se transferem do middleware de rota verbatim, porque um global é
apenas um elemento anterior do mesmo array:

- **Curto-circuito.** Um global pode `return` uma `Response` para parar a requisição. Ele
  pula todo global posterior, toda a cadeia `use:` e o handler. A resposta retornada
  ainda recebe o header `x-request-id` e é logada como qualquer outro
  desfecho.
- **Scoped slots.** Um scoped slot que um middleware global `provides:` é legível via
  `c.get` em *todo* handler — o global roda antes do handler e escreve no mesmo
  store por requisição que o handler lê. Um `authMiddleware` global com
  `provides: ['currentUser']` torna `c.get('currentUser')` válido em toda rota
  sem que essa rota o liste em `use:`.

::: warning Um global roda para toda rota
Não há opt-out por rota. Um middleware na cadeia global roda para toda
rota, inclusive as que não precisam dele. Escolher e ordenar a cadeia é
sua responsabilidade. Se uma preocupação for genuinamente específica de uma rota, mantenha-a no
`use:` daquela rota.
:::

## Built-ins

Três middlewares de hardening de primeira parte vêm da entrada core do `kata`. Cada um é
uma factory de `Middleware<R>`, declara `provides: []` e define headers de resposta (ou
rejeita uma requisição) sem tocar no corpo da resposta.

### `cors`

```ts
function cors<R extends Registry = Registry>(options?: CorsOptions): Middleware<R>
```

Um wrapper fino sobre o `cors` do Hono. `CorsOptions` espelha as opções do Hono —
`origin`, `allowMethods`, `allowHeaders`, `exposeHeaders`, `maxAge`,
`credentials` — veja a [documentação de CORS do Hono](https://hono.dev/docs/middleware/builtin/cors).

```ts
import { cors } from 'katajs'

createApp({
  modules: [users],
  middlewares: [cors({ origin: 'https://app.example.com', credentials: true })],
})
```

::: warning O preflight não é tratado pela cadeia global
O Kata registra um handler apenas para o método declarado de uma rota e não tem rota
`OPTIONS` implícita, então um preflight de navegador (`OPTIONS`) nunca é correspondido. `cors()` na
cadeia global ainda define os headers `Access-Control-Allow-*` na resposta
real, mas não responde ao preflight. Para tratamento completo de preflight, veja
[Tratando o preflight de CORS](#handling-cors-preflight) abaixo.
:::

### `secureHeaders`

```ts
function secureHeaders<R extends Registry = Registry>(
  options?: SecureHeadersOptions,
): Middleware<R>
```

Um wrapper fino sobre o `secureHeaders` do Hono. Sem opções, ele aplica a baseline
endurecida do Hono — `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security` e mais — e remove
`X-Powered-By`. `SecureHeadersOptions` espelha as opções do Hono (`xFrameOptions`,
`strictTransportSecurity`, `contentSecurityPolicy`, `referrerPolicy`, …); passe
`false` para um header individual para desativá-lo. Veja a
[documentação de secure-headers do Hono](https://hono.dev/docs/middleware/builtin/secure-headers).

```ts
import { secureHeaders } from 'katajs'

createApp({
  modules: [users],
  middlewares: [secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"] } })],
})
```

### `bodyLimit`

```ts
function bodyLimit<R extends Registry = Registry>(
  options?: BodyLimitOptions,
): Middleware<R>
```

O runtime do Kata lê o corpo da requisição via `c.req.json()` sem guarda de tamanho. Adicione
`bodyLimit` para rejeitar payloads grandes demais antes que sejam bufferizados e parseados. O
limite é imposto via o header `Content-Length` (caminho rápido) e, quando ausente, pela
medição do corpo em streaming.

```ts
type BodyLimitOptions = {
  maxSize?: number // bytes; defaults to DEFAULT_MAX_BODY_SIZE (1 MiB)
  onError?: (c: Context) => Response | Promise<Response>
}
```

`maxSize` tem como padrão `DEFAULT_MAX_BODY_SIZE` — `1024 * 1024` (1 MiB), exportado
de `kata`. Quando o limite é excedido, o `onError` padrão retorna HTTP `413`
com o envelope de erro unificado do kata ([ADR-0008](/adr/0008-unified-error-response-envelope)):

```json
{ "error": "payload_too_large", "message": "Request body exceeds the maximum allowed size" }
```

```ts
import { bodyLimit } from 'katajs'

createApp({
  modules: [users],
  middlewares: [bodyLimit({ maxSize: 8 * 1024 })], // 8 KiB
})
```

## Adaptando um middleware do Hono

Os três built-ins não são especiais: cada um é um middleware comum do Hono envolvido para encaixar
no contrato `Middleware<R>` do Kata. Entender *por que* o wrapper é necessário explica uma
restrição real sobre o que pode entrar em uma cadeia.

Aqui está o problema. O Kata constrói sua resposta no *fim* da cadeia de uma rota e
a retorna desacoplada de `c.res`. Um middleware normal do Hono que define headers de resposta
*depois* do seu próprio `next()` — `secureHeaders` é um deles — espera escrever esses headers em
`c.res` no caminho de volta. Mas a essa altura o Kata já tirou um snapshot da resposta, então
esses headers simplesmente seriam descartados.

O wrapper contorna isso mudando *quando* o middleware do Hono roda. Ele executa o
middleware envolvido até a conclusão primeiro, entregando-lhe um `next` inerte, de modo que todo header que ele
define caia em `c.res` *antes* de o Kata construir a resposta — então ele continua a própria cadeia
do Kata. E se o middleware envolvido der curto-circuito com uma `Response` (um `413`, um
preflight de CORS `204`), essa resposta é retornada e a cadeia para.

O porém: isso é correto apenas para middlewares que **definem headers de resposta ou rejeitam uma
requisição**. Um *transformador* de resposta — compressão, ETag — precisa observar o corpo
final, o que ele nunca consegue aqui, então ele não pertence a um `use:` ou a uma cadeia global de
forma alguma. (Esta é a mesma restrição sob a qual o middleware de rota vive; veja o aviso de `c.header`
em [Middleware](/pt/guide/middleware).)

Para middlewares que você escreve por conta própria — populando um scoped slot a partir de um cookie de
sessão ou API key, adicionando camadas de autorização — não envolva um middleware do Hono. Use `defineMiddleware`
e escreva no store scoped com `c.set` diretamente. Veja [Middleware](/pt/guide/middleware)
para o padrão de preenchimento de slots e [Auth com JWT](/pt/guide/jwt) para o caminho específico de auth.

## Tratando o preflight de CORS

`cors()` na cadeia global define headers de CORS em respostas reais, mas não
responde ao preflight `OPTIONS`, porque o kata não tem rota `OPTIONS` implícita.
`createApp` retorna um app Hono paramétrico, então registre um middleware nativo do Hono nele
para o preflight:

```ts
import { cors as honoCors } from 'hono/cors'

const app = createApp({
  modules: [users],
  middlewares: [cors(), secureHeaders()],
})

// Middleware nativo do Hono no app retornado — responde ao preflight OPTIONS.
app.use('*', honoCors({ origin: 'https://app.example.com', credentials: true }))

export type AppType = typeof app
```

::: tip
`app.use('*', …)` aqui é uma chamada Hono pura, não parte da cadeia `middlewares`
do kata — ela não enxerga o store scoped e não flui pelo funil de
resposta do kata. Use-a apenas para o preflight; mantenha suas preocupações de tempo de requisição na
cadeia `middlewares` do kata.
:::

## Veja também

- [Middleware](/pt/guide/middleware) — o contrato `Middleware<R>`, `provides:` e
  o preenchimento de scoped slots.
- [Referência: middleware](/pt/reference/middleware) — assinaturas exatas dos
  built-ins e seus tipos de opções.
- [ADR-0012](/adr/0012-app-level-middleware) — por que a cadeia global estende a
  cadeia manual de rotas em vez de `app.use`.
