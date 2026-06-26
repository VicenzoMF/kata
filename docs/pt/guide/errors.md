---
title: O envelope de erro
description: Um único formato para todo erro do Kata — o envelope de validação 422, o output mismatch 500 e status customizados via c.error / c.json.
---

# O envelope de erro

O Kata produz **um único** formato de erro. Toda resposta 4xx e 5xx — falhas de
validação, seus próprios erros de domínio, output mismatches, throws não
capturados — é o mesmo envelope JSON:

```ts
type ErrorBody = {
  error: string                          // código estável, legível por máquina
  message: string                        // descrição legível por humanos
  issues?: Record<string, FieldIssue[]>  // erros de campo estruturados, indexados pela seção de input
}
```

- `error` — o discriminador no qual um cliente faz switch (`'not_found'`,
  `'validation_failed'`, `'internal_error'`). Nunca contém uma frase humana.
- `message` — uma descrição legível por humanos. Sempre presente.
- `issues` — presente apenas quando há erros de campo estruturados (hoje:
  validação de input).

Isso é imposto pelo runtime, não por convenção. Ambas as pontas de toda route
são validadas, e cada modo de falha mapeia para este envelope. Os dois
automáticos vêm primeiro; os que você escreve vêm depois.

| Estágio | Quando | Em caso de falha |
|---|---|---|
| **Input** | antes do handler rodar | `422` `validation_failed` |
| **Handler lança** | qualquer escape de middleware ou handler | `500` `internal_error` |
| **Output** | depois do handler retornar um valor | `500` `internal_output_shape_mismatch` (depende do modo) |
| **Seu 4xx** | você faz `return c.error(...)` / `c.json(...)` | seu status |

## O envelope de validação 422

`input` é validado **antes** do seu handler. Em caso de falha o Kata nunca chama
o handler — ele responde `422` com `error: "validation_failed"`, a message
`"Request input validation failed"` e um objeto `issues` **indexado pela seção de
input** que falhou (`params` / `query` / `body` / `headers`). Cada chave contém
um array de field issues.

Para o body `{ "name": "", "email": "not-an-email" }` de `POST /users` contra o
`CreateUserBodySchema`, a resposta é (este formato é verificado pelo `users.hurl`
de [`examples/hello`](/pt/guide/quickstart); as strings literais de `message` são
do Zod):

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

### O formato `FieldIssue`

Toda entrada sob `issues` é um `FieldIssue`:

```ts
type FieldIssue = {
  path: string       // caminho com ponto/colchete: "email", "user.profile.age", "items[1].qty"
  message: string    // mensagem legível por humanos do Zod
  code: string       // código de issue do Zod: "too_small", "invalid_type", "invalid_string", …
  expected?: unknown // presente apenas quando a issue do Zod a carrega (erros de tipo)
  received?: unknown // presente apenas quando a issue do Zod a carrega (erros de tipo)
}
```

Regras para deixar claras:

- `path` usa notação de ponto para objetos aninhados e `[n]` para índices de
  array. Um erro no nível raiz tem um `path: ""` vazio.
- `expected` / `received` aparecem **apenas** quando a issue do Zod subjacente os
  carrega (isto é, `invalid_type`) e são omitidos caso contrário.
- As issues são reportadas na ordem do código-fonte. Quando mais de uma seção é
  inválida (por exemplo, tanto `params` quanto `body`), cada uma recebe sua
  própria chave sob `issues`.

::: tip Reutilize o formatador
Se você validar algo por conta própria — um payload de webhook, uma query
re-parseada, uma regra entre campos — e quiser que a resposta corresponda
exatamente a este formato, `formatZodIssues(error: ZodError): FieldIssue[]` é
exportado de `kata`. Construa o envelope com
`c.error('validation_failed', 'Request input validation failed', { status: 422, issues: { body: formatZodIssues(parsed.error) } })`.
:::

## Validação de output e `internal_output_shape_mismatch`

Quando seu handler retorna um **valor simples** (não um `Response`), o Kata o
passa pelo schema `output` da route antes de serializar. O que acontece em caso
de mismatch é definido pelo modo `outputValidation` da aplicação
([ADR-0009](/adr/0009-output-validation-mode)):

| Modo | Em caso de mismatch | Ambiente pretendido |
|---|---|---|
| `strict` | Loga as issues, retorna `500` `internal_output_shape_mismatch` | dev / test / CI |
| `log` | Loga as issues, envia os dados do handler sem alteração | produção |
| `off` | Pula a validação de output por completo | opt-out crítico para performance |

Os três modos traçam a tensão entre *capturar bugs* e *manter-se no ar*: `strict`
falha de forma ruidosa, para que um formato errado nunca passe despercebido em dev ou CI; `log` mantém
a produção servindo, permitindo que um desvio benigno se torne uma linha de log em vez de uma interrupção;
`off` remove a checagem por completo onde cada microssegundo conta.

O modo é resolvido uma vez no `createApp`, a primeira correspondência vence:

1. o `outputValidation` explícito passado para `createApp`,
2. a env var `KATA_OUTPUT_VALIDATION` quando ela nomeia um modo válido,
3. derivado de `NODE_ENV` — `production` → `log`, caso contrário `strict`.

```ts
const app = createApp({ modules: [users], outputValidation: 'strict' })
```

No modo `strict` as issues do Zod são logadas em `console.error` e a resposta é
exatamente:

```json
{ "error": "internal_output_shape_mismatch", "message": "Response did not match the declared output schema" }
```

com status `500`. Isso pega "o handler retornou _quase_ o formato certo" antes
que chegue a um cliente. No modo `log` as issues ainda são logadas, mas os dados
do handler são enviados sem alteração — um desvio de formato benigno em produção
se degrada para uma linha de log em vez de um 500 abrupto. No modo `off` não há
`safeParse` nem transform do Zod; os dados passam como estão.

::: warning O mismatch nunca vaza para o cliente
Em um mismatch `strict` o cliente recebe o envelope genérico
`internal_output_shape_mismatch`. As issues ofensivas do Zod são logadas apenas
no servidor — nomes de campos e o formato interno nunca cruzam a rede.
:::

## Throws não capturados: `internal_error`

Um throw que escapa de qualquer middleware ou handler é capturado pela fronteira
de erro global do Kata e serializado através do mesmo envelope:

```json
{ "error": "internal_error", "message": "Internal server error" }
```

com status `500` e `Content-Type: application/json` — nunca a página 500
text/HTML padrão do Hono. Essa fronteira existe para que um bug nunca possa vazar um stack trace ou uma
página de erro HTML para um cliente: o erro bruto é logado no servidor, e a mensagem
subjacente nunca é exposta ao cliente.

Reserve o throw para bugs genuínos. Para falhas que o cliente deve entender, retorne
`c.error(...)`.

## Status customizados: `c.error` e `c.json`

Para erros de domínio — not found, forbidden, conflict — **retorne um `Response`**
do handler. A forma idiomática é `c.error(code, message, extra?)`, que constrói o
envelope unificado; `c.json(value, status?)` é o escape hatch para um formato
customizado. Ambos estão disponíveis nos contextos da route **e** do middleware.

```ts
return c.error('not_found', 'No user with that id', { status: 404 })
// → 404  { "error": "not_found", "message": "No user with that id" }
```

Assinatura de `c.error`:

```ts
c.error(code: string, message: string, extra?: ErrorExtra): Response

type ErrorExtra = {
  status?: number                        // padrão 400
  issues?: Record<string, FieldIssue[]>  // anexa erros de campo estruturados
}
```

- O argumento `code` torna-se o campo `error` na rede.
- `status` vai dentro de `extra` e **tem padrão `400`**.
- Anexe erros de campo estruturados via `extra.issues` (o mesmo formato `FieldIssue[]`
  do envelope 422).

A distinção que governa o pipeline de resposta (a mesma de
[Routes & schemas](/pt/guide/routes-schemas)):

- **retornar um valor** → validado contra `output`, enviado como `200`.
- **retornar `c.error(...)` / `c.json(body, status)`** → carrega seu próprio
  status.

### Respostas retornadas e o schema `output`

Com um **único** schema `output`, um `Response` retornado (incluindo `c.error`)
faz um short-circuit na route e **não** é checado contra ele — que é exatamente o
motivo pelo qual é permitido que um body de erro difira do seu formato de sucesso.

```ts
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 }) // não validado
    return user                                                               // validado contra UserSchema
  },
})
```

Para tipar **e** validar bodies de erro também, declare `output` como um mapa
status→schema ([ADR-0011](/adr/0011-multi-status-output-schemas)). O Kata
fornece `ErrorBodySchema` exatamente para isso — o espelho em Zod do envelope
unificado:

```ts
import { ErrorBodySchema } from 'katajs'

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
```

Na forma de mapa: um return simples é o body `200`; `c.json(body, 201)` é
validado contra `output[201]`; um `c.error(...)` cujo status está declarado é
validado contra o schema daquele status. **Status não declarados ainda passam
adiante** sem validação. O `Response` original é encaminhado literalmente em caso
de sucesso — o Kata nunca re-serializa uma resposta que seu handler construiu,
então um header ou content type que você definiu é preservado. O cliente RPC
faz o narrow por status: `InferResponseType<call, 404>`. Veja
[`defineRoute`](/pt/reference/define-route) para o contrato completo de `output`.

## O que é automático vs. o que você escreve

| Situação | Status | Quem produz |
|---|---|---|
| Input falha em seu schema | `422` | Kata (automático) |
| Handler retorna um valor que corresponde ao `output` | `200` | Kata |
| Handler retorna `c.error(...)` / `c.json(body, status)` | seu status | você |
| Valor de retorno do handler falha no `output` | `500` (depende do modo) | Kata (automático) |
| Handler **lança** | `500` | fronteira de erro do Kata |

## Pegadinhas

- **Um body JSON malformado é lido como `undefined`**, e então falha em seu schema
  `body` — portanto aparece como um `422` normal, não como um crash de parse.
- **Toda resposta carrega um id de correlação.** Sucesso ou erro, o Kata ecoa um
  header `X-Request-Id` (reutilizando um header de entrada bem-formado, caso
  contrário um UUID novo). Veja [Ciclo de vida](/pt/guide/lifecycle).
- **`status` não é um argumento posicional em `c.error`.** Ele vive dentro de
  `extra` e tem padrão `400` — `c.error('not_found', '…')` sem um status retorna
  `400`, não `404`.

## Veja também

- [`defineRoute`](/pt/reference/define-route) — o contrato de `input` / `output`.
- [Cookbook de erros](/pt/cookbook/errors) — receitas trabalhadas para retornar seus próprios 4xx.
