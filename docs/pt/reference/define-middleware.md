---
title: defineMiddleware
description: Referência da API de defineMiddleware — o formato da config, a tipagem de provides, o MiddlewareContext e o short-circuit.
---

# defineMiddleware

`defineMiddleware` produz um `Middleware<R>`: um valor que prepara uma requisição
antes do handler rodar e preenche os **scoped slots** declarados em
`defineContext`. Ele é retornado por `defineContext`, vinculado ao seu registry `R`,
então importe-o do seu módulo de contexto — não do `kata`.

```ts
import { defineMiddleware } from '../context'
```

Para a narrativa — como o middleware compõe sobre rotas, preenche slots e faz
short-circuit — veja [Middleware & scoped slots](/pt/guide/middleware). Esta página é
a referência da assinatura.

## Assinatura

```ts
defineMiddleware<const P extends readonly ScopedKeys<R>[]>(config: {
  provides: P
  handler: (
    c: MiddlewareContext<R>,
    next: () => Promise<void>,
  ) => Promise<void | Response> | void | Response
}): Middleware<R>
```

A config tem exatamente dois campos, ambos obrigatórios:

| Campo | Tipo | Propósito |
| --- | --- | --- |
| `provides` | `readonly ScopedKeys<R>[]` | As chaves de scoped slot que este middleware preenche. |
| `handler` | `(c, next) => Promise<void \| Response> \| void \| Response` | Roda o setup, preenche slots, opcionalmente faz short-circuit. |

O valor retornado é opaco — `{ __kata: 'middleware', provides, handler }`. Você
não lê seus campos; você o passa para o `use:` de uma rota ou para o
`middlewares:` do app.

## `provides` e `as const`

`provides` lista as chaves de scoped slot que o middleware preenche. O tipo dos seus
elementos é `ScopedKeys<R>` — apenas chaves **scoped** do seu registry são aceitas; uma
chave singleton ou uma string desconhecida é um erro de tipo.

Escreva o array `as const`:

```ts
provides: ['currentUser'] as const
```

Sem `as const`, o array alarga para `string[]` e as chaves literais são perdidas.
`as const` as mantém como uma tupla de literais de string, o que faz duas coisas:

- As chaves continuam grepáveis e verificáveis pelo lint. A regra
  `kata/scoped-slot-not-provided` une o `provides` da cadeia de uma rota
  para provar que todo `c.get('slot')` no handler tem um provedor.
- O compilador prende cada entrada a `ScopedKeys<R>`, então um typo ou uma chave não scoped
  falha no ponto de chamada de `defineMiddleware`.

Um middleware que não preenche nenhum slot — um que só lê um header ou rejeita uma
requisição — declara uma tupla vazia:

```ts
provides: [] as const
```

## O handler

```ts
handler: (
  c: MiddlewareContext<R>,
  next: () => Promise<void>,
) => Promise<void | Response> | void | Response
```

`c` é o [contexto do middleware](#middlewarecontext). `next` continua a cadeia;
dê `await` nele para rodar o middleware restante e (eventualmente) o handler. Código
após `await next()` roda no caminho de volta — é aqui que o cleanup pertence.

Um handler faz uma de duas coisas:

- **Continuar** — chamar `await next()` e não retornar nada (`void`).
- **Short-circuit** — retornar um `Response` (veja [abaixo](#short-circuiting)).

```ts
export const requireAuth = defineMiddleware({
  provides: ['currentUser'] as const,
  handler: async (c, next) => {
    const userId = c.header('x-user-id')
    if (!userId) return c.error('unauthorized', 'Missing x-user-id header', { status: 401 })

    c.set('currentUser', { id: userId })
    await next()
  },
})
```

Este é o auth de brinquedo do `examples/shop` na íntegra. Ele lê um header, rejeita quando ele
está ausente e, caso contrário, preenche o scoped slot `currentUser` antes de continuar.

## `MiddlewareContext`

`c` é um `MiddlewareContext<R>` — uma superfície menor que o contexto da rota (ele
não tem `input`). Todo método é tipado contra o seu registry `R`.

```ts
type MiddlewareContext<R extends Registry> = {
  get<K extends keyof R>(key: K): ResolvedValue<R[K]>
  set<K extends ScopedKeys<R>>(key: K, value: ResolvedValue<R[K]>): void
  raw: import('hono').Context
  header(name: string): string | undefined
  json<T>(value: T, status?: number): Response
  error(code: string, message: string, extra?: ErrorExtra): Response
  requestId: string
}
```

| Membro | Comportamento |
| --- | --- |
| `c.get('key')` | Lê qualquer slot registrado — um singleton, ou um scoped slot já preenchido nesta requisição. Compila para qualquer chave registrada. Ler um scoped slot antes de ele ser setado lança erro. |
| `c.set('key', value)` | Preenche um scoped slot. O parâmetro de tipo é `ScopedKeys<R>`, então só compila para chaves scoped; passar uma chave singleton lança erro em runtime. |
| `c.header('name')` | Lê um header da requisição. Retorna `string \| undefined`. |
| `c.json(value, status?)` | Constrói um `Response` JSON. `status` tem default `200`. Retorne-o para fazer short-circuit. |
| `c.error(code, message, extra?)` | Constrói o envelope de erro unificado (ADR-0008). `extra.status` tem default `400`. Retorne-o para fazer short-circuit. |
| `c.requestId` | O id de correlação desta requisição — o `x-request-id` de entrada quando bem-formado, caso contrário um UUID novo. |
| `c.raw` | O `Context` subjacente do Hono. Uma válvula de escape. |

::: warning `c.header` lê, ele não escreve
`c.header(name)` é um **getter** de header da requisição. Não há setter para headers de
resposta nem pós-processamento de body: o Kata constrói sua resposta desacoplada de
`c.res`, então uma cadeia prepara a requisição e pode fazer short-circuit, mas não pode
reescrever o body final. Transformadores de resposta (compressão, ETag) não pertencem
a um middleware. Para setar um header de resposta, faça-o em `c.raw` antes de retornar, ou
construa o `Response` você mesmo.
:::

## Short-circuiting

O tipo de retorno do handler é `Promise<void | Response> | void | Response`.
**Retornar um `Response` interrompe a requisição imediatamente** — todo
middleware posterior, a validação de input e o handler são todos pulados. Retornar
`void` (ou apenas chamar `await next()`) continua.

Construa o `Response` de short-circuit com `c.error(...)` para uma rejeição esperada
ou `c.json(...)` para um sucesso customizado:

```ts
handler: async (c, next) => {
  const token = c.header('authorization')
  if (!token) return c.error('unauthorized', 'Missing Authorization header', { status: 401 })
  // ...verifica, preenche slot...
  await next()
}
```

Uma resposta de short-circuit ainda flui pelo restante da contabilidade do pipeline
— ela recebe o header `x-request-id` e é logada como qualquer outro
desfecho. Como ela nunca chega ao handler, um status levantado por um middleware **não**
faz parte do contrato `output` da rota; não o declare em `output:`.

Lançar (throw) também interrompe a requisição, mas como um erro não tratado: ele é logado
no servidor e canalizado para o envelope unificado `500 internal_error`. Use
`return c.error(...)` para uma rejeição esperada; deixe um throw sinalizar um bug
genuíno. Veja [Erros](/pt/guide/errors).

## Relação com scoped slots

Um scoped slot (declarado `scoped<T>()` em `defineContext`) começa cada requisição
vazio e é preenchido por um middleware. O contrato tem dois lados:

- `provides` é a declaração **em nível de tipo** de quais slots o middleware
  preenche, imposta contra `ScopedKeys<R>` e verificada pela regra de lint
  `kata/scoped-slot-not-provided`.
- `c.set('key', value)` é o preenchimento em **runtime**. O tipo do valor é
  `ResolvedValue<R[K]>` — o `T` que você deu a `scoped<T>()`.

Um handler lê o slot com `c.get('key')` e o recebe de volta totalmente tipado. A
leitura só é sólida se um middleware provedor rodou antes; caso contrário ela lança erro
(`scoped slot 'key' read before being set`). Singletons não precisam de provedor — eles
vivem pelo tempo de vida do processo.

Um middleware que possui um recurso também pode fazer cleanup após `next()`. O
slot de transação do `examples/shop` abre uma unidade de trabalho, preenche o slot e faz
rollback em qualquer caminho que não tenha dado commit:

```ts
export const withTransaction = defineMiddleware({
  provides: ['tx'] as const,
  handler: async (c, next) => {
    const tx = c.get('store').begin()
    c.set('tx', tx)
    try {
      await next()
    } catch (err) {
      tx.rollback()
      throw err
    }
    // Alcançado apenas quando o handler retornou sem dar commit (ex.: ele fez
    // short-circuit com c.error). rollback() é um no-op uma vez que houve commit.
    if (tx.status === 'open') tx.rollback()
  },
})
```

Veja [Middleware & scoped slots](/pt/guide/middleware) para o ciclo de vida completo do slot
e [Context & DI](/pt/guide/context-di) para declarar slots em `defineContext`.

## Composição

Um `Middleware<R>` é composto em um de dois lugares, ambos recebendo
`readonly Middleware<R>[]`:

- **Por rota** — `defineRoute({ use: [requireAuth, withTransaction], ... })`.
  A cadeia roda da esquerda para a direita antes do handler. Veja
  [defineRoute](/pt/reference/define-route).
- **No app inteiro** — `createApp({ middlewares: [secureHeaders(), cors()], ... })`.
  Roda antes do `use:` próprio de cada rota; a cadeia efetiva de uma rota é
  `[...config.middlewares, ...route.use]`. Veja [createApp](/pt/reference/create-app).

A mesma instância compõe sobre quantas rotas você quiser — não há
duplicação por rota.

## Veja também

- [Middleware & scoped slots](/pt/guide/middleware) — o guia completo.
- [defineContext](/pt/reference/define-context) — declarando scoped slots e singletons.
- [defineRoute](/pt/reference/define-route) — `use:` e o contrato `output`.
- [createApp](/pt/reference/create-app) — a cadeia `middlewares:` em nível de app.
- [Middleware embutido](/pt/reference/middleware) — `cors`, `secureHeaders`, `bodyLimit`.
- [JWT auth](/pt/reference/jwt) — `jwtAuth` e os guards.
