---
title: defineRoute
description: Referência da API de defineRoute — o tipo de configuração da rota, os schemas de input e output, o contexto do handler e o comportamento de validação.
---

# defineRoute

`defineRoute` declara uma rota: um método HTTP, um path, os schemas para o que
entra e o que sai dela, uma cadeia opcional de middleware e um handler. Ele é
retornado por [`defineContext`](/pt/reference/define-context), vinculado ao seu
registry — não importado globalmente — de modo que `c.get('key')` dentro do
handler só passa na verificação de tipos para chaves que você registrou.

```ts
import { defineRoute } from '../../context'

import { EchoBodySchema, EchoResponseSchema } from './echo.schema'

export const echoRoute = defineRoute({
  method: 'POST',
  path: '/echo',
  input: { body: EchoBodySchema },
  output: EchoResponseSchema,
  handler: (c) => ({ echoed: c.input.body.message }),
})
```

`defineRoute` retorna um valor `Route`. Um arquivo `.route.ts` contém chamadas de
`defineRoute` e nada mais; [`createApp`](/pt/reference/create-app) coleta cada
rota exportada por meio de um namespace import do arquivo.

## Assinatura

```ts
function defineRoute<
  const M extends HttpMethod,
  const P extends string,
  const I extends InputSchemas,
  const O extends OutputSpec,
>(config: {
  method: M
  path: P
  use?: readonly Middleware<R>[]
  input: I
  output: O
  handler: (c: RouteContext<R, I>) => Promise<RouteHandlerReturn<O>> | RouteHandlerReturn<O>
}): Route<R, M, P, I, O>
```

`R` é o registry com que o `defineContext` envolvente foi chamado. `M`, `P`,
`I` e `O` são inferidos como os tipos mais estreitos a partir do literal que você
passa (parâmetros de tipo `const`), de modo que `method` e `path` fluem para o
cliente RPC tipado, e `c.input` é tipado exatamente a partir de `input`.

| Campo     | Tipo                       | Obrigatório | Notas |
|-----------|----------------------------|-------------|-------|
| `method`  | `HttpMethod`               | sim         | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` |
| `path`    | `string`                   | sim         | Uma string de path do Hono, ex. `'/users/:id'` |
| `input`   | `InputSchemas`             | sim         | `{ params?, query?, body?, headers? }`; `{}` é válido |
| `output`  | `OutputSpec`               | sim         | Um único schema Zod ou um mapa status→schema |
| `use`     | `readonly Middleware<R>[]` | não         | Padrão `[]`; executa antes do handler |
| `handler` | `(c) => …`                 | sim         | Retorna um valor ou um `Response` |

`input` e `output` são ambos obrigatórios — omitir qualquer um deles é um erro de TypeScript
([ADR-0003](/adr/0003-mandatory-input-output-schemas)). `use` assume `[]`
quando omitido; middleware de nível de app declarado em `createApp` executa antes dele
([App middleware](/pt/guide/app-middleware)).

## `input`

`input` é um objeto com qualquer uma de quatro chaves opcionais, cada uma um schema Zod:

```ts
type InputSchemas = {
  params?: z.ZodTypeAny
  query?: z.ZodTypeAny
  body?: z.ZodTypeAny
  headers?: z.ZodTypeAny
}
```

Cada chave mapeia para uma parte da requisição, lida e validada antes do handler:

| Chave     | Origem                                |
|-----------|---------------------------------------|
| `params`  | parâmetros de path (`/users/:id`)     |
| `query`   | query string da URL                   |
| `body`    | corpo JSON da requisição já parseado  |
| `headers` | headers da requisição, chaves em minúsculas |

As chaves de header são normalizadas para minúsculas antes da validação (nomes de
header HTTP são case-insensitive), então um schema de `headers` precisa usar
chaves em minúsculas — `z.object({ authorization: z.string() })`, não `Authorization`.

Declare apenas as seções que a rota lê. Uma rota que não lê nenhuma ainda
declara `input` explicitamente como `{}` — o contrato para "esta rota não recebe
input".

```ts
export const requestIdRoute = defineRoute({
  method: 'GET',
  path: '/request-id',
  input: {},
  output: RequestIdResponseSchema,
  handler: (c) => ({ requestId: c.requestId }),
})
```

### `c.input`

Dentro do handler, `c.input` tem uma propriedade por seção, tipada a partir do seu
schema (`z.infer`). Uma seção que você não declarou é tipada como `undefined`:

```ts
type InferInput<I extends InputSchemas> = {
  params: I['params'] extends z.ZodTypeAny ? z.infer<I['params']> : undefined
  query: I['query'] extends z.ZodTypeAny ? z.infer<I['query']> : undefined
  body: I['body'] extends z.ZodTypeAny ? z.infer<I['body']> : undefined
  headers: I['headers'] extends z.ZodTypeAny ? z.infer<I['headers']> : undefined
}
```

Assim, `c.input.params.id` só passa na verificação de tipos quando `input.params` é declarado. Os
valores são a saída **parseada** de cada schema — transforms, coerções e
defaults do Zod já foram aplicados.

## `output`

`output` é ou um único schema Zod ou um mapa de código de status HTTP para schema:

```ts
type OutputMap = { readonly [status: number]: z.ZodTypeAny }
type OutputSpec = z.ZodTypeAny | OutputMap
```

### Schema único

A forma de schema único é o corpo de sucesso `200`. Este é o caso comum.

```ts
export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
```

### Mapa status→schema

A forma de mapa declara um formato de corpo por código de status
([ADR-0011](/adr/0011-multi-status-output-schemas)). Use-a quando uma rota responde
mais de um status com um contrato que você quer tipado e validado — um corpo de
sucesso mais um envelope de erro, ou um sucesso não-`200` como `201`:

```ts
import { ErrorBodySchema } from 'katajs'

export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const result = checkout(c.get('tx'), c.get('currentUser').id)
    if (!result.ok) return c.error('conflict', 'Out of stock', { status: 409 })
    return c.json(result.order, 201)
  },
})
```

`ErrorBodySchema` é exportado de `katajs`. É o espelho em Zod do envelope de erro
unificado que `c.error(...)` produz ([Errors](/pt/guide/errors)), então é o
schema canônico para colocar atrás de um status `4xx`/`5xx`. Um app pode substituí-lo
por um refinamento mais estrito (por exemplo, um código `error` literal) para um contrato mais rígido.

### Para qual status um retorno mapeia

`SuccessOutput<O>` é o tipo que um **retorno simples** deve satisfazer — sempre o
corpo `200`: o `z.infer` do schema único, ou de `output[200]` para um mapa.

```ts
type SuccessOutput<O extends OutputSpec> =
  O extends z.ZodTypeAny
    ? z.infer<O>
    : O extends OutputMap
      ? 200 extends keyof O ? z.infer<O[200]> : never
      : never

type RouteHandlerReturn<O extends OutputSpec> = SuccessOutput<O> | Response
```

Um mapa sem entrada `200` faz `SuccessOutput` resolver para `never`, então o
handler é forçado a retornar um `Response` — o `checkoutRoute` acima declara `201`
mas não `200`, então `c.json(result.order, 201)` é a única forma de responder sucesso.
Todo status diferente de `200` é definido explicitamente com `c.json(body, status)` ou
`c.error(...)`.

::: tip
A forma de mapa é retrocompatível no nível de valor: uma rota que usa um único
`output: Schema` compila e se comporta exatamente como um mapa com apenas uma entrada `200`.
:::

## O contexto do handler

O handler recebe `c: RouteContext<R, I>`:

```ts
type RouteContext<R extends Registry, I extends InputSchemas> = {
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  input: InferInput<I>
  json<T>(value: T, status?: number): Response
  error(code: string, message: string, extra?: ErrorExtra): Response
  requestId: string
  raw: import('hono').Context
}
```

| Membro       | Propósito |
|--------------|-----------|
| `c.input`    | O input da requisição parseado e tipado (veja acima). |
| `c.get(key)` | Lê uma dependência registrada — valor singleton ou scoped slot. Só passa na verificação de tipos para chaves em `defineContext`. |
| `c.json`     | Constrói um `Response` JSON; `status` assume `200`. |
| `c.error`    | Constrói o envelope de erro unificado ([ADR-0008](/adr/0008-unified-error-response-envelope)); `status` assume `400`. |
| `c.requestId`| O id de correlação por requisição, também ecoado no header de resposta `x-request-id`. |
| `c.raw`      | O `Context` subjacente do Hono — uma válvula de escape. |

### Retornar um valor ou um `Response`

Um handler retorna uma de duas coisas:

- **Um valor simples** — validado contra o schema de sucesso e então serializado como uma
  resposta JSON `200`. Transforms do Zod se aplicam.
- **Um `Response`** — construído com `c.json` ou `c.error` para definir um status customizado.

```ts
export const getProductRoute = defineRoute({
  method: 'GET',
  path: '/products/:id',
  input: { params: z.object({ id: z.string() }) },
  output: ProductSchema,
  handler: (c) => {
    const product = getProduct(c.get('store'), c.input.params.id)
    if (!product) return c.error('not_found', 'Product not found', { status: 404 })
    return product // validado contra ProductSchema, enviado como 200
  },
})
```

### `c.get` — ler dependências

`c.get(key)` retorna o valor resolvido de um slot registrado: o valor de um singleton,
ou um scoped slot preenchido por um middleware em `use` (ou por middleware de
nível de app). Ler um scoped slot que nenhum middleware na cadeia forneceu
lança em runtime, então liste o middleware provedor em `use`.

```ts
export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser], // fornece o scoped slot 'currentUser'
  input: {},
  output: UserSchema,
  handler: (c) => c.get('currentUser'),
})
```

Veja [Context & DI](/pt/guide/context-di) para os tipos de slot e a ligação de middleware.

### `c.error` e `ErrorExtra`

`c.error` produz o envelope de erro unificado e assume o status `400`. Seu
terceiro argumento define outro status e erros de campo estruturados opcionais:

```ts
type ErrorExtra = {
  status?: number      // status HTTP; assume 400
  issues?: FieldIssues // erros de campo estruturados, anexados sob `issues`
}
```

```ts
return c.error('not_found', 'User not found', { status: 404 })
```

## Comportamento de validação

O Kata valida `input` **antes** de o handler executar e `output` **depois** de ele
retornar ([ADR-0003](/adr/0003-mandatory-input-output-schemas)). Veja
[Errors](/pt/guide/errors) para a referência completa do envelope.

### Input — antes do handler

Cada seção declarada é parseada com `safeParse`. Se alguma falha, o handler
nunca executa e o Kata responde `422` com um envelope fixo: `error:
"validation_failed"`, uma `message` e um objeto `issues` com chaves pela seção
que falhou (`params`, `query`, `body` ou `headers`), cada uma um array de issues
de campo.

```json
{
  "error": "validation_failed",
  "message": "Request input validation failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "String must contain at least 1 character(s)" },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Cada issue de campo é `{ path, message, code }`, com `expected` /
`received` opcionais para incompatibilidades de tipo. `path` usa notação de ponto/colchete para campos
aninhados (`address.zip`, `tags[0]`). Um schema de `body` com um corpo ilegível ou
não-JSON é parseado contra `undefined`, então o schema decide o desfecho.

### Output — depois do handler

Um **retorno simples** é validado contra o schema de sucesso (o schema único,
ou `output[200]`). Em caso de incompatibilidade sob o modo `strict` padrão, o Kata responde
`500 { "error": "internal_output_shape_mismatch" }` e loga as issues Zod
ofensoras no servidor — o formato errado nunca chega ao cliente.

Um `Response` retornado carrega seu próprio status. Na **forma de mapa**, quando esse
status é uma chave declarada, o Kata valida um clone do corpo contra
`output[status]` e encaminha o `Response` original inalterado em caso de sucesso
(headers e content type definidos pelo handler são preservados). Na
**forma de schema único**, e para qualquer status que o mapa não declara, um
`Response` passa direto sem validação.

::: info Modo de validação de output
O comportamento `strict` acima é o padrão fora de produção. O modo —
`strict` (loga + `500`), `log` (loga + serve os dados mesmo assim) ou `off` (pula a
validação) — é definido por app em `createApp` ou via a variável de ambiente
`KATA_OUTPUT_VALIDATION`; produção assume `log` por padrão. Veja
[ADR-0009](/adr/0009-output-validation-mode).
:::

## Veja também

- [Routes & schemas](/pt/guide/routes-schemas) — o passo a passo do guia.
- [Errors](/pt/guide/errors) — os envelopes `422` e `500`, e como retornar seu próprio `4xx`.
- [`defineContext`](/pt/reference/define-context) — de onde `defineRoute` e `c.get` vêm.
- [`createApp`](/pt/reference/create-app) — coletando rotas em um app.
- [`defineMiddleware`](/pt/reference/define-middleware) — preenchendo os scoped slots que `c.get` lê.
