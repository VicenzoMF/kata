---
title: Rotas & schemas
description: Defina uma rota com defineRoute — schemas Zod obrigatórios de input e output, handlers tipados e respostas com múltiplos status.
---

# Rotas & schemas

Uma rota é uma única chamada a `defineRoute`. Nessa única chamada você declara tudo o que
o framework precisa saber sobre um endpoint: seu método HTTP e path, o formato do
que entra (*in*), o formato do que sai (*out*), uma cadeia opcional de middleware e
o handler que faz o trabalho.

A regra principal é que **tanto `input` quanto `output` são obrigatórios** — omita qualquer um
e é um erro de TypeScript, não algo que você descobre em produção
([ADR-0003](/adr/0003-mandatory-input-output-schemas)). O motivo é que o contrato de uma
rota — o que ela aceita e o que ela retorna — nunca deve ser implícito. Ele é
escrito, checado por tipos e (como você verá) imposto em runtime em ambas as pontas.

`defineRoute` vem do *seu context*, não de um import global. `defineContext`
o retorna já vinculado ao seu registry (veja [Context & DI](/pt/guide/context-di)),
o que é o que permite que `c.get('key')` dentro do handler passe na checagem de tipos
exatamente para os slots que você declarou.

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

Um arquivo de rota contém chamadas a `defineRoute` e nada mais. Exporte cada rota como um
const nomeado; `createApp` depois as coleta importando o arquivo `.route.ts` inteiro
como um namespace, para que cada rota exportada seja captada automaticamente.

## O formato de `defineRoute`

Aqui está o objeto completo, com a função de cada campo:

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

`method` e `path` não são apenas strings para o sistema de tipos — eles são inferidos como
tipos *literais* e fluem até o cliente RPC, para que um chamador saiba que este é
um `POST /echo` e nada mais. `use` assume `[]` quando você o omite; qualquer
middleware de nível de app registrado em `createApp` roda *antes* da cadeia `use:`
da própria rota (veja [Middleware de app](/pt/guide/app-middleware)).

## `input` — as quatro seções

Uma requisição HTTP não chega como uma coisa só. Seus dados vivem em quatro lugares
diferentes, e `input` espelha exatamente esses quatro. Você fornece um schema Zod para cada
seção que a rota realmente lê:

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

| Seção     | De onde vem                       |
|-----------|-----------------------------------|
| `params`  | parâmetros de path (`/users/:id`) |
| `query`   | a query string da URL             |
| `body`    | o corpo JSON da requisição parseado |
| `headers` | headers da requisição (em minúsculas) |

::: warning Chaves de header são minúsculas
Nomes de header HTTP são case-insensitive, então o Kata converte toda chave de
header recebida para minúsculas antes de validar. Por isso o seu schema de
`headers` precisa usar chaves em minúsculas — `z.object({ authorization: z.string() })`,
nunca `Authorization`. Um schema com a chave `Authorization` nunca casa, e a
requisição falha na validação com `422`.
:::

Declarar uma seção faz dois trabalhos de uma vez só. Em runtime, o Kata valida essa parte da
requisição contra o seu schema *antes do handler rodar*. Em tempo de compilação, ele tipa
o campo correspondente em `c.input` — então dentro do handler `c.input.params.id` é uma
`string` conhecida, não `any`. Uma seção que você não declarou é tipada como `undefined` em
`c.input`, então ler `c.input.query` só passa na checagem de tipos quando você realmente declarou um
schema `query`. Um único schema é a fonte da verdade tanto para a checagem em runtime quanto para o
tipo estático; eles não podem divergir.

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

Uma rota que não lê *nenhuma* das quatro seções ainda declara `input` — como um objeto
vazio:

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
`input: {}` não é ruído de boilerplate — é o contrato declarando, em voz alta, "esta
rota não lê input". A regra de lint `kata/no-route-without-input-schema` exige
que ele esteja presente e explícito, para que "eu esqueci de pensar no input" e "esta rota
genuinamente não tem nenhum" nunca pareçam iguais no código fonte.
:::

(`c.input` aqui é o objeto de input validado, e `c.requestId` é um id de correlação
por requisição — ambos ficam pendurados no mesmo objeto de contexto `c` introduzido em
[Context & DI](/pt/guide/context-di).)

## `output` — schema único ou map de status

`output` descreve o que a rota tem permissão para enviar de volta. Ele assume uma de duas
formas:

```ts
type OutputMap = { readonly [status: number]: z.ZodTypeAny }
type OutputSpec = z.ZodTypeAny | OutputMap
```

### Schema único

A forma de schema único descreve o corpo de sucesso `200` — o caso comum, para uma
rota com apenas um formato de caminho feliz:

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

Recorra à forma de map quando uma rota responde a mais de um status e você quer
que *cada* um deles seja tipado e validado — digamos um corpo de sucesso `200` e um envelope de erro
`404` ([ADR-0011](/adr/0011-multi-status-output-schemas)):

```ts
import { ErrorBodySchema } from 'katajs'

output: { 200: UserSchema, 404: ErrorBodySchema }
```

`ErrorBodySchema` é exportado de `kata`. É o espelho Zod do envelope de erro unificado
que `c.error(...)` produz (veja [Erros](/pt/guide/errors)), o que o torna
o schema canônico para colocar atrás de qualquer status `4xx`/`5xx`. Quando quiser um
contrato mais apertado, substitua-o por um refinamento mais estrito — por exemplo, travando `error`
em um código literal.

::: info Como o Kata escolhe contra qual status validar
Esta é a regra que liga um valor de retorno a um código de status:

- Um **return simples** é *sempre* o corpo `200`. O Kata o valida contra o
  schema único, ou contra `output[200]` em um map.
- Todo **outro status** é um que você define explicitamente, com `c.json(body, status)` ou
  `c.error(...)`.

Então um map do qual você retorna valores simples *precisa* incluir uma entrada `200`. Se não incluir,
o tipo de return simples colapsa para `never`, e o TypeScript força você a retornar um
`Response` em vez disso — o que é exatamente o certo para, digamos, uma rota de criação que só
responde `201`.
:::

A forma de map é totalmente retrocompatível: uma rota escrita com um único
`output: Schema` compila e se comporta exatamente como antes.

## O handler

O handler é a função que roda a requisição. Ele recebe o contexto `c` e
retorna uma de duas coisas — e qual você retorna decide como o Kata constrói a
resposta:

- **Um valor simples** — o caminho de sucesso. O Kata o valida contra o schema
  de sucesso, aplica quaisquer transforms do Zod e o serializa como uma resposta JSON `200`.
  Este é o caso que você escreverá com mais frequência.
- **Um `Response`** — o caminho explícito, para qualquer status além de um simples `200`. Você
  o constrói com `c.json(value, status?)` ou `c.error(code, message, extra?)`.

```ts
json<T>(value: T, status?: number): Response
error(code: string, message: string, extra?: ErrorExtra): Response
```

`c.json` assume status `200` por padrão. `c.error` produz o envelope de erro unificado e
assume status `400` por padrão; seu terceiro argumento define qualquer outra coisa:

```ts
type ErrorExtra = {
  status?: number      // status HTTP; padrão 400
  issues?: FieldIssues // erros de campo estruturados, anexados sob `issues`
}
```

(`c.json` e `c.error` são os construtores de resposta em `c`; o envelope que `c.error`
emite é documentado em detalhes em [Erros](/pt/guide/errors).)

Retornar um `Response` pula o caminho de sucesso de valor simples — então o que acontece com seu
corpo depende de qual forma de `output` você usou:

- **Forma de map, e o status da resposta é uma chave declarada** → O Kata valida um
  *clone* do corpo contra `output[status]`, depois encaminha seu `Response`
  original inalterado assim que ele passar.
- **Forma de schema único, ou qualquer status que o map não declare** → o `Response`
  passa direto sem validação.

Veja [ADR-0011](/adr/0011-multi-status-output-schemas) para a semântica exata.

Além dos construtores de resposta, o contexto entrega ao handler `c.get(key)` para suas
dependências registradas (veja [Context & DI](/pt/guide/context-di)), `c.requestId` para
o id de correlação, e `c.raw` — o contexto Hono subjacente, uma escape hatch para
a rara coisa que o Kata não encapsula.

## Validação, em ambas as pontas

Junte as duas metades e você tem a promessa central do Kata: uma rota é checada na
entrada *e* na saída
([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

**Na entrada.** Se a requisição falhar no seu schema de `input`, o handler nunca roda.
O Kata responde `422` com um envelope fixo: `error: "validation_failed"`, uma
`message` e um objeto `issues` indexado pela seção que falhou, cada uma contendo um
array de issues de campo:

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
aninhados (`address.zip`, `tags[0]`), de forma que um cliente pode mapear um erro diretamente de volta
ao campo que o causou.

**Na saída.** Se um *return simples* não corresponde ao seu schema de `output`, o Kata
responde `500 { "error": "internal_output_shape_mismatch" }` e loga as issues Zod
ofensoras no lado do servidor — o formato errado nunca chega ao cliente. Esse é o
comportamento `strict` (o padrão fora de produção); o
[modo de validação de output](/pt/guide/errors) decide se uma incompatibilidade gera 500, loga e
serve mesmo assim, ou é ignorada completamente.

Veja [Erros](/pt/guide/errors) para a referência completa do envelope e como retornar seu
próprio `4xx`.

## Schemas vivem em `<domain>.schema.ts`

Uma regra de layout surge aqui: schemas **nunca** são declarados inline em um arquivo `.route.ts`.
Os schemas Zod de cada domínio vivem em `src/modules/<domain>/<domain>.schema.ts`,
e rotas os importam pelo nome ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).
Um `z.object(...)` inline em um arquivo de rota é um erro de lint (`kata/inline-schema`).

Isso não é organização apenas por capricho. Puxar schemas para o seu próprio arquivo é o que
permite que uma rota *e* o seu [service](/pt/guide/services) compartilhem exatamente o mesmo tipo, e
mantém cada DTO localizável de duas maneiras: por glob (`src/modules/**/*.schema.ts`) e por
busca exata de símbolo (`grep "UserSchema"`).

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
import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'
```

Duas convenções de nomenclatura mantêm isso consistente:

- `*Schema` para os próprios schemas Zod.
- Um tipo `*` correspondente (ex.: `User`, `CreateUserBody`) inferido via `z.infer`,
  declarado logo ao lado do seu schema.

Como o tipo é inferido *a partir* do schema, os dois nunca podem divergir — e o
[service](/pt/guide/services) permanece uma função pura sobre esses tipos inferidos, sem
imports de framework:

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
