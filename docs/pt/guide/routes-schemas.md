---
title: Rotas & schemas
description: Defina uma rota com defineRoute — schemas Zod obrigatórios de input e output, handlers tipados e respostas com múltiplos status.
---

# Rotas & schemas

Uma rota é uma única chamada a `defineRoute`. Ela declara um método HTTP, um path,
os schemas para o que entra na rota, o schema para o que sai dela, uma
cadeia opcional de middleware e um handler. Tanto `input` quanto `output` são
obrigatórios — omitir qualquer um deles é um erro de TypeScript ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

`defineRoute` vem do seu context, não de um import global. `defineContext`
o retorna vinculado ao seu registry, de modo que `c.get('key')` dentro do handler só
passa na checagem de tipos para as keys que você registrou (veja [Context & DI](/pt/guide/context-di)).

```ts
// src/modules/echo/echo.route.ts
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

Um arquivo de rota contém chamadas a `defineRoute` e nada mais. Exporte cada rota
como um const nomeado; `createApp` as coleta por meio de um namespace import do
arquivo `.route.ts`.

## O formato de `defineRoute`

```ts
defineRoute({
  method,   // 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path,     // uma string de path do Hono, ex.: '/users/:id'
  input,    // { params?, query?, body?, headers? } — cada um um schema Zod
  output,   // um único schema Zod OU um map status→schema
  use,      // opcional: Middleware[] que roda antes do handler desta rota
  handler,  // (c) => value | c.json(...) | c.error(...)
})
```

`method` e `path` são inferidos como tipos literais e fluem para o cliente RPC.
`use` assume `[]` quando omitido; o middleware de nível de app vindo de `createApp` roda
antes dele (veja [Middleware de app](/pt/guide/app-middleware)).

## `input` — as quatro seções

`input` é um objeto com qualquer uma de quatro keys, cada uma um schema Zod:

```ts
type InputSchemas = {
  params?: z.ZodTypeAny
  query?: z.ZodTypeAny
  body?: z.ZodTypeAny
  headers?: z.ZodTypeAny
}
```

Você declara apenas as seções que a rota lê. Cada uma mapeia para uma parte da
requisição:

| Seção     | Origem                            |
|-----------|-----------------------------------|
| `params`  | parâmetros de path (`/users/:id`) |
| `query`   | query string da URL               |
| `body`    | corpo JSON da requisição já parseado |
| `headers` | headers da requisição (em minúsculas) |

Dentro do handler, `c.input` é tipado a partir desses schemas. Uma seção que você não
declarou é `undefined` em `c.input`, então ler `c.input.query` só passa na checagem de tipos
quando você declarou um schema `query`.

```ts
// src/modules/users/users.route.ts
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: GetUserParamsSchema },
  output: { 200: UserSchema, 404: ErrorBodySchema },
  handler: async (c) => {
    const user = await getUser(c.input.params.id) // string, tipado
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
  },
})
```

Uma rota que não lê nenhuma das quatro seções ainda declara `input`
explicitamente, como um objeto vazio:

```ts
export const requestIdRoute = defineRoute({
  method: 'GET',
  path: '/request-id',
  input: {},
  output: RequestIdResponseSchema,
  handler: (c) => ({ requestId: c.requestId }),
})
```

::: tip
`input: {}` não é ruído de boilerplate — é o contrato declarando "esta rota
não lê input". A regra de lint `kata/no-route-without-input-schema` exige que ele
esteja presente e explícito.
:::

## `output` — schema único ou map de status

`output` é ou um único schema Zod ou um map de código de status HTTP para schema:

```ts
type OutputMap = { readonly [status: number]: z.ZodTypeAny }
type OutputSpec = z.ZodTypeAny | OutputMap
```

### Schema único

A forma de schema único descreve o corpo de sucesso `200`. Este é o caso
comum.

```ts
export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
```

### Map de status para schema

A forma de map declara um formato de corpo por código de status ([ADR-0011](/adr/0011-multi-status-output-schemas)).
Use-a quando uma rota responde a mais de um status com um contrato que você quer tipado
e validado — por exemplo, um corpo de sucesso `200` e um envelope de erro `404`:

```ts
import { ErrorBodySchema } from 'kata'

output: { 200: UserSchema, 404: ErrorBodySchema }
```

`ErrorBodySchema` é exportado de `kata`. É o espelho Zod do envelope de erro
unificado que `c.error(...)` produz ([Erros](/pt/guide/errors)), então é
o schema canônico para colocar atrás de um status `4xx`/`5xx`. Um app pode substituí-lo por
um refinamento mais estrito (por exemplo, um código `error` literal) quando quiser um
contrato mais apertado.

::: info Como o status é escolhido
Um **return simples** é sempre o corpo `200` — ele é validado contra o schema
único, ou contra `output[200]` para um map. Todo outro status é definido explicitamente
com `c.json(body, status)` ou `c.error(...)`.

Um map usado com returns simples precisa, portanto, declarar uma entrada `200`. Se não
declarar, o tipo do return simples é `never` e o handler é forçado a retornar um
`Response` — por exemplo, uma rota de criação que sempre responde apenas `201`.
:::

A forma de map é totalmente retrocompatível no nível de valor: uma rota que usa
um único `output: Schema` compila e se comporta exatamente como antes.

## O handler

O handler recebe o context da rota `c` e retorna uma de duas coisas:

- **um valor simples** — validado contra o schema de sucesso e então serializado como uma
  resposta JSON `200`. Transforms do Zod se aplicam.
- **um `Response`** — construído com `c.json(value, status?)` ou
  `c.error(code, message, extra?)` para definir um status customizado.

```ts
json<T>(value: T, status?: number): Response
error(code: string, message: string, extra?: ErrorExtra): Response
```

`c.json` assume status `200` por padrão. `c.error` produz o envelope de erro unificado
e assume status `400` por padrão; passe `{ status }` (e opcionalmente `issues`) em seu
terceiro argumento para definir outro:

```ts
type ErrorExtra = {
  status?: number      // status HTTP; padrão 400
  issues?: FieldIssues // erros de campo estruturados, anexados sob `issues`
}
```

Retornar um `Response` causa um curto-circuito: a validação do corpo depende da
forma de `output`. Na forma de map, quando o status da resposta é uma key declarada,
o Kata valida um clone do corpo contra `output[status]` e encaminha o
`Response` original inalterado em caso de sucesso. Na forma de schema único — e para qualquer
status que o map não declare — um `Response` passa direto sem validação. Veja
[ADR-0011](/adr/0011-multi-status-output-schemas) para a semântica exata de
validação.

O context da rota também expõe `c.get(key)` para dependências registradas,
`c.requestId` (o id de correlação por requisição) e `c.raw` (o context Hono
subjacente — uma escape hatch).

## Validação, em ambas as pontas

O Kata valida `input` **antes** de o handler rodar e `output` **depois** que ele
retorna ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

Quando o input falha em seu schema, o handler nunca roda. O Kata responde `422` com um
envelope fixo: `error: "validation_failed"`, uma `message` e um objeto `issues`
indexado pela seção de input que falhou, cada uma um array de issues de campo:

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

Cada issue de campo é `{ path, message, code }`, com `expected` / `received`
opcionais para incompatibilidades de tipo. `path` usa notação de ponto/colchete para campos
aninhados (`address.zip`, `tags[0]`).

Quando um **return simples** não corresponde ao seu schema de `output`, o Kata responde
`500 { "error": "internal_output_shape_mismatch" }` e loga as issues Zod
ofensoras no lado do servidor — o formato errado nunca chega ao cliente. Este é o
comportamento `strict` (o padrão fora de produção); o
[modo de validação de output](/pt/guide/errors) governa se uma incompatibilidade gera 500, loga
e serve mesmo assim, ou é ignorada.

Veja [Erros](/pt/guide/errors) para a referência completa do envelope e como retornar
seu próprio `4xx`.

## Schemas vivem em `<domain>.schema.ts`

Schemas nunca são declarados inline em um arquivo `.route.ts`. Os schemas Zod de cada
domínio vivem em `src/modules/<domain>/<domain>.schema.ts`; rotas os importam pelo
nome ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)). Um `z.object(...)`
inline em um arquivo de rota é um erro de lint (`kata/inline-schema`).

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
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
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

```ts
// src/modules/users/users.route.ts
import { ErrorBodySchema } from 'kata'

import { defineRoute } from '../../context'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'
```

Convenções de nomenclatura:

- `*Schema` para schemas Zod.
- tipos `*` (ex.: `User`, `CreateUserBody`) inferidos via `z.infer`, declarados
  ao lado do schema.

Isso mantém o contrato User localizável por glob (`src/modules/**/*.schema.ts`) e
por busca exata de símbolo (`grep "UserSchema"`), e permite que tanto a rota quanto seu
[service](/pt/guide/services) importem o mesmo formato. O service permanece uma função
pura sobre esses tipos inferidos:

```ts
// src/modules/users/users.service.ts
import type { CreateUserBody, User } from './users.schema'

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  return user
}
```

## Veja também

- [Erros](/pt/guide/errors) — os envelopes `422` e `500`, e como retornar seu próprio `4xx`.
- [Referência de `defineRoute`](/pt/reference/define-route) — a assinatura completa e os tipos.
- [Context & DI](/pt/guide/context-di) — de onde vêm `defineRoute` e `c.get`.
- [Services](/pt/guide/services) — as funções puras que um handler chama.
