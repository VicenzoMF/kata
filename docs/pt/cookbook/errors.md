# Receita: Erros e validação

**Problema:** retornar respostas de erro corretas e previsíveis — e entender os dois
envelopes que o Kata produz automaticamente.

O Kata valida as duas pontas de toda route ([ADR-0003](/adr/0003-mandatory-input-output-schemas)):

| Etapa | Quando | Em caso de falha |
|---|---|---|
| **Input** | antes do handler rodar | envelope `422` `validation_failed` (abaixo) |
| **Output** | depois do handler retornar um valor | `500` `internal_output_shape_mismatch` |

Um body não-vazio que não é JSON válido é rejeitado ainda mais cedo, com `400`
`validation_failed` (`message: "Malformed JSON body"`) — antes da etapa de input,
então ele nunca chega ao seu schema `body`. (Um body vazio ou ausente ainda é lido
como `undefined` e deixa o schema decidir.)

Todo o resto — seus próprios 4xx — você retorna explicitamente do handler.

## O envelope de validação 422

Quando o input da requisição falha em seu schema, o Kata nunca chama seu handler. Ele responde
`422` com um formato fixo: um discriminador `error` de nível superior, uma `message`
legível e um objeto `issues` **indexado pela seção do input** (`params` /
`query` / `body` / `headers`), cada um contendo um array de issues de campo.

Para o body `{ "name": "", "email": "not-an-email" }` de `POST /users` contra
`CreateUserBodySchema`, a resposta é exatamente (asseverada em
[`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl)):

```json
{
  "error": "validation_failed",
  "message": "Request input validation failed",
  "issues": {
    "body": [
      { "path": "name",  "code": "too_small",      "message": "..." },
      { "path": "email", "code": "invalid_string", "message": "Invalid email" }
    ]
  }
}
```

Cada entrada é um `FieldIssue`, definido em
[`packages/kata/src/errors.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/errors.ts):

```ts
export type FieldIssue = {
  path: string // caminho com ponto/colchete: "email", "user.profile.age", "items[1].qty"
  message: string // mensagem legível do Zod
  code: string // código de issue do Zod: "too_small", "invalid_type", …
  expected?: unknown // presente apenas em erros de tipo
  received?: unknown // presente apenas em erros de tipo
}
```

Notas:
- `path` usa notação de ponto para objetos aninhados e `[n]` para índices de array; um
  erro de nível raiz tem `path: ""` vazio.
- `expected` / `received` aparecem **apenas** quando a issue subjacente do Zod os
  carrega (ou seja, `invalid_type`), sendo omitidos nos demais casos.
- As issues são reportadas na ordem do código-fonte; várias seções inválidas (ex.: `params`
  e `body` juntos) recebem cada uma sua própria chave sob `issues`.

## Retornando seus próprios 4xx

Para erros de domínio (não encontrado, proibido, conflito…), **retorne um `Response`** do
handler. A forma idiomática é `c.error(code, message, { status })`, que
constrói o envelope unificado do Kata (veja [abaixo](#the-unified-error-envelope-cerror));
`c.json(body, status)` é a válvula de escape para um formato customizado. De qualquer modo,
retornar um `Response` curto-circuita a route: o Kata o envia como está e
**não** o valida contra o schema `output` — que é precisamente o motivo de um body de
erro poder diferir do seu formato de sucesso.

```ts
// não encontrado — espelha examples/hello
handler: async (c) => {
  const user = await findUser(c.get('db'), c.input.params.id)
  if (!user) return c.error('not_found', 'User not found', { status: 404 })
  return user // um valor simples É validado contra `output`
}
```

O mesmo se aplica dentro de middleware (ex.: o `401` em [auth.md](/pt/cookbook/auth)).
A distinção a manter clara:

- **retornar um valor** → validado contra `output`, enviado como `200`.
- **retornar `c.error(...)` / `c.json(body, status)`** → enviado literalmente, qualquer status, não validado.

## Reaproveitando o formatador de issues do framework

Se você validar algo por conta própria — um payload de webhook, uma query parseada que
pós-processa, uma regra entre campos — e quiser que sua resposta combine com o formato 422
do Kata, o formatador é exportado. `formatZodIssues(error)` transforma um `ZodError`
em `FieldIssue[]`:

```ts
import { formatZodIssues } from '@katajs-framework/core'

handler: async (c) => {
  const parsed = WebhookSchema.safeParse(await c.raw.req.json())
  if (!parsed.success) {
    return c.error('validation_failed', 'Request input validation failed', {
      status: 422,
      issues: { body: formatZodIssues(parsed.error) },
    })
  }
  // … parsed.data está tipado
}
```

Isso mantém respostas de validação feitas à mão compatíveis byte a byte com as automáticas,
de modo que os clientes parseiam um único formato.

## Validação de output (o envelope 500)

Depois que seu handler retorna um **valor**, o Kata o passa pelo schema `output` da
route. Como uma divergência é tratada é definido pelo modo `outputValidation`
([ADR-0009](/adr/0009-output-validation-mode)): `strict` (loga + `500`),
`log` (loga, mas envia os dados do handler sem alteração) ou `off` (pula a
validação). O padrão é `strict` fora de produção e `log` em produção,
e é sobrescrevível via `createApp({ outputValidation })` ou a variável de ambiente
`KATA_OUTPUT_VALIDATION`.

No modo `strict`, as issues do Zod são logadas no servidor (através do seu
`logger` injetado, se houver um registrado, senão `console.error`) e a resposta é:

```json
{ "error": "internal_output_shape_mismatch", "message": "Response did not match the declared output schema" }
```

com status `500` — pegando "o handler retornou _quase_ o formato certo" antes
que chegue a um cliente. No modo `log`, as issues ainda são logadas, mas os dados do
handler são enviados, então um bug de formato em produção degrada para uma linha de log em vez
de uma resposta com falha.

## Testando o error boundary sem uma route de crash

**Problema:** você quer um teste que verifique o envelope `500` `internal_error`
do Kata (a última linha da tabela acima) — mas a única forma de disparar isso é
uma route que lança, e um `GET /diagnostics/boom` dedicado, vivendo no array
`modules: [...]` do `main.ts`, ficaria de pé como um endpoint permanente de
"derrubar o servidor de propósito", acessível em produção.

**Solução:** chame `createApp`/`defineRoute` uma segunda vez — as mesmas
funções que o `main.ts` usa, vindas do mesmo `./context` — mas faça isso
*dentro do arquivo de teste*, sobre uma route descartável que nunca é
exportada nem adicionada ao array `modules` real da aplicação. `createApp`
apenas constrói um app `Hono` a partir do array `modules` que você passar;
nada exige que esse array seja o mesmo que o `main.ts` de fato serve:

```ts
// examples/hello/src/error-boundary.test.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createApp, defineRoute } from './context' // a própria factory + registry da app

// Definida só aqui — não em um arquivo `*.route.ts`, então nunca é importada
// pelo main.ts e nunca é registrada na app que de fato escuta em uma porta.
const crashRoute = defineRoute({
  method: 'GET',
  path: '/__test-only/boom',
  input: {},
  output: z.object({ ok: z.boolean() }),
  handler: () => {
    throw new Error('forced failure — error-boundary test only')
  },
})

describe('error boundary: forçando um 500 sem uma route de crash embarcada', () => {
  it('transforma um erro lançado pelo handler no envelope unificado internal_error', async () => {
    // Apenas a route local ao teste — os modules reais do main.ts
    // ([users, auth, echo, diag]) nunca são importados aqui.
    const app = createApp({ modules: [{ crashRoute }] })
    const res = await app.request('/__test-only/boom')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'internal_error',
      message: 'Internal server error',
    })
  })
})
```

Isso exercita o caminho de código real — o mesmo try/catch de `registerRoute`
e o fallback `app.onError` que a app embarcada roda, ligados ao mesmo registry
de `defineContext` — sem adicionar uma única route ao array `modules` do
`main.ts`. O app `Hono` construído aqui vive apenas durante o teste; ele nunca
passa por `serve()`, então `/__test-only/boom` nunca é alcançável fora do
`vitest run`. A própria suíte do Kata cobre o error boundary do mesmo jeito
(`packages/kata/src/context.test.ts`, `describe('global error boundary (#62)')`):
um `defineContext({})` descartável e uma route `/boom` construída inline no teste.

::: tip Prefira isso a uma dependência falha injetável
Se uma route já depende de algo registrado via `defineContext` — um singleton
`db`, um `mailer` — trocá-lo por uma versão que lança, em um teste específico,
é uma forma legítima de cobrir o caminho de falha *daquele handler*. Só que
isso não generaliza do mesmo jeito: só funciona para routes que por acaso têm
uma dependência falível para envenenar. O module só-de-teste acima não precisa
de nada específico da route, então é a recomendação padrão para verificar o
error boundary em si; use um mock de dependência falha quando estiver testando
o modo de falha específico de um handler.
:::

## Testando o error boundary sobre HTTP real (Hurl/curl)

**Problema:** a seção acima resolve o caso do Vitest, mas uma suíte E2E que
exercita a app sobre **HTTP real** — Hurl, curl, Playwright, qualquer
ferramenta fora do processo — não consegue reaproveitá-la. `createApp({
modules: [{ crashRoute }] })` em `error-boundary.test.ts` constrói um objeto
de app `Hono` de verdade, mas o teste nunca chama `serve()` sobre ele: nada
abre uma porta, então não existe um `http://localhost` para um arquivo
`.hurl` (ou qualquer outra ferramenta externa) enviar uma requisição. A route
só existe durante a chamada a `app.request(...)`, em processo, dentro do
`vitest run`.

Não há como contornar isso mantendo a route de crash inalcançável: uma
ferramenta fora do processo só consegue acessar uma route que faça parte do
servidor que o `main.ts` de fato inicializa — ou seja, algo no array `modules`
real. Tornar o envelope `500`/`internal_error` exercitável a partir de HTTP
real exige, portanto, inevitavelmente, uma route que lança e que *é*
alcançável em produção.

**Solução:** aceitar esse trade-off explicitamente, uma vez, em vez de deixar
cada consumidor reinventá-lo. O `examples/hello` já tem exatamente isso: uma
route `GET /boom` permanente no seu module
[`users`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.route.ts)
(já ligado ao array `modules: [users, auth, echo, diag]` do `main.ts`):

```ts
// examples/hello/src/modules/users/users.route.ts
export const boomRoute = defineRoute({
  method: 'GET',
  path: '/boom',
  input: {},
  output: BoomResponseSchema, // nunca é de fato retornado — o handler sempre lança
  handler: () => {
    throw new Error('intentional handler explosion')
  },
})
```

Verificada de ponta a ponta em
[`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl)
contra o servidor de fato em execução (`pnpm --filter=hello start`, depois
`pnpm --filter=hello hurl`):

```hurl
GET http://localhost:3000/boom
HTTP 500
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.error" == "internal_error"
jsonpath "$.message" exists
```

::: warning
Não crie uma segunda `/boom` em outro module (por exemplo, um module com cara
de `diag`) para "isolar" isso. O Kata registra as routes na ordem do array
`modules`, e uma route do Kata nunca chama `next()` — então o primeiro
handler registrado para um dado método+path sempre vence. Uma route duplicada
no mesmo path é código morto inalcançável, não uma rede de segurança extra.
:::

**Isso é um endpoint permanente de "derrubar o servidor de propósito",
acessível em produção** — exatamente o que a route só-de-teste da seção
anterior foi construída para evitar. Isso é um trade-off deliberado e aceito
em troca de cobertura E2E sobre HTTP real, não um descuido: mantenha-o como um
único throw incondicional, sem lógica de negócio, e não se surpreenda quando
uma varredura de segurança ou um colega sinalizar `GET /boom` — esse é o
custo dessa cobertura, pago conscientemente. Se esse custo for inaceitável
para o seu deployment, proteja a route atrás de uma checagem de ambiente (por
exemplo, só a registre quando `NODE_ENV !== 'production'`) e rode a
verificação de HTTP real contra um build que não seja de produção.

## O que é automático vs. o que você escreve

| Situação | Status | Quem produz |
|---|---|---|
| Input falha em seu schema | `422` | Kata (automático) |
| Handler retorna um valor que combina com `output` | `200` | Kata |
| Handler retorna `c.error(...)` / `c.json(body, status)` | seu `status` | você |
| Valor de retorno do handler falha em `output` | `500` | Kata (automático) |
| Handler **lança** | `500` | Error boundary do Kata — envelope unificado `internal_error` |

## O envelope de erro unificado: `c.error`

Para erros de domínio, prefira `c.error(code, message, extra?)` em vez de um
`c.json` feito à mão. Ele constrói o envelope de erro único do Kata — o formato `{ error, message,
issues? }` que todo 4xx/5xx do Kata produz
([ADR-0008](/adr/0008-unified-error-response-envelope)):

```ts
return c.error('not_found', 'No user with that id', { status: 404 })
// → 404  { "error": "not_found", "message": "No user with that id" }
```

`c.error` está disponível tanto nos contextos de route quanto de middleware. O argumento `code`
se torna o campo `error` na rede; `status` tem padrão `400`; anexe erros de campo
estruturados via `extra.issues` (o mesmo formato `FieldIssue[]` do envelope
422 acima). Com um único schema `output`, um `Response` retornado
(`c.error` incluído) curto-circuita a route e **não** é checado contra ele;
declare um map status→schema (veja _Pegadinhas_) para tipar e validar bodies de erro também.

## Pegadinhas

- **Um erro lançado vira um `500` opaco.** O error boundary global do Kata
  captura qualquer throw que escape de um handler ou middleware e o serializa como um
  envelope unificado `{ "error": "internal_error", "message": "Internal server error" }`
  (status `500`) — nunca a página padrão de texto/HTML do Hono, e nunca
  vazando a mensagem subjacente. Prefira `c.error(...)` para falhas que o cliente
  deve entender, e reserve o throw para bugs genuínos.
- **`output` pode ser um único schema ou um map status→schema (ADR-0011).** Um único
  schema é o body 200, e os `Response`s retornados o ignoram. Para tipar _e_
  validar outros status, declare um map —
  `output: { 200: UserSchema, 404: ErrorBodySchema }` (o Kata fornece `ErrorBodySchema`
  para o envelope unificado). Então um retorno simples é o body 200, `c.json(body, 201)`
  é validado contra `output[201]`, e um `c.error(...)` cujo status é declarado
  é validado contra o schema daquele status. Status não declarados ainda passam direto.
  `hc<typeof app>` estreita as respostas por status: `InferResponseType<call, 404>`.
- **Um body JSON malformado retorna `400`** `validation_failed` (`message:
  "Malformed JSON body"`) **antes** da validação de schema rodar — os bytes
  inválidos nunca chegam ao seu schema `body`. Um body *vazio ou ausente* é
  diferente: ele é lido como `undefined`, então o schema `body` decide o desfecho
  (um body opcional passa; um obrigatório falha em seu schema → `422`).
