---
title: O que é Kata
description: Uma camada fina e opinativa sobre o Hono — funcional, completa em schemas e verificável mecanicamente.
---

# O que é Kata

Kata é uma camada fina e opinativa sobre o [Hono](https://hono.dev). O Hono te dá
o roteador, os adaptadores cross-runtime e o cliente RPC tipado. O Kata adiciona
a parte que o Hono deixa em aberto: como você estrutura uma aplicação, de onde vêm
as dependências e como uma route pode se parecer.

> Opinativo como o NestJS, funcional como um script, verificável como um sistema
> de tipos. Construído para que agentes de IA e humanos produzam código correto na
> primeira tentativa.

O nome é a tese. Um _kata_ é uma forma disciplinada e treinada — e `型`
também significa *tipo* e *molde*. Kata é um molde para código de backend: uma forma,
repetida até virar automática, a mesma independentemente de quem escreve, humano ou agente.

## Uma camada fina, não uma reescrita

O Kata envolve o roteador e o context do Hono, mas não reexporta a API do Hono. A
superfície pública são quatro funções — `defineContext`, `defineRoute`,
`defineMiddleware`, `createApp` — mais o cliente RPC do Hono para tipos ponta a ponta
([ADR-0001](/adr/0001-use-hono-as-base)). Todo o resto é um objeto comum que você
passa para uma delas.

```ts
import { defineContext, scoped, singleton } from 'kata'

export const k = defineContext({
  logger: singleton(console),
  currentUser: scoped<{ id: string }>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

`defineContext` é a raiz. Ele recebe seu registry de dependências e retorna
`defineRoute`, `defineMiddleware` e `createApp` já vinculados a ele, de modo que o
resto da sua aplicação herda os tipos. Como o Kata fica sobre o Hono, ele roda onde
quer que o Hono rode — Node, Bun, Deno, edge — e a aplicação que `createApp` retorna é
um app Hono de verdade, que você pode estender.

## Apenas funcional

O Kata não tem classes, não tem decorators e não tem container IoC em runtime
([ADR-0002](/adr/0002-no-classes-no-decorators)). Uma route é `defineRoute({...})`
e nada mais. Uma dependência é uma entrada em `defineContext`. Não existe
`@Injectable()`, nem reflection de metadados, nem cadeia de herança para rastrear.

Isso não é nostalgia. Decorators no estilo NestJS codificam fluxo de controle difícil
de buscar com grep e difícil de verificar mecanicamente — os metadados rodam no momento
da decoração, o container resolve em runtime, e nenhum dos dois é visível no código-fonte. A
aposta do Kata é a oposta: **restrições ajudam agentes**. Funções, objetos comuns e
imports explícitos são inspecionáveis por uma ferramenta, não só por um humano. Apenas exports nomeados;
o tipo `any` é proibido (use `unknown` e faça narrowing).

## Três invariantes

O Kata impõe três regras. Juntas, elas tornam uma aplicação verificável mecanicamente —
checável por um passe de lint em um hook `PostToolUse`, em menos de 100ms, sem subir
a aplicação.

### 1. DI estática

Toda dependência é declarada em um único `defineContext({...})`. Existem dois
tipos de slot:

- `singleton(value)` — um valor para todo o tempo de vida do processo (um pool de banco, um logger,
  um mailer).
- `scoped<T>()` — um valor por requisição, preenchido por um middleware (o usuário
  atual, um id de tenant, uma transação).

`c.get('key')` só passa na checagem de tipos para uma key que você registrou. Não existem
buscas por string que escapem do sistema de tipos, então o grafo completo de dependências
é enumerável a partir de um único arquivo ([ADR-0004](/adr/0004-di-via-scoped-slots)).

### 2. Schemas obrigatórios

Toda route declara tanto um schema de `input` quanto de `output` — omitir qualquer um deles é
um erro de TypeScript ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

```ts
export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: z.object({ id: z.string() }) },
  output: UserSchema,
  handler: async (c) => {
    const user = await getUser(c.input.params.id)
    if (!user) return c.json({ error: 'not_found' }, 404)
    return user
  },
})
```

`input` é validado **antes** do handler; em caso de falha o Kata retorna `422` com
um envelope normalizado `{ error: "validation_failed", issues }`. `output` é
validado **depois** do handler; uma divergência é logada e convertida em `500
{ "error": "internal_output_shape_mismatch" }`, de modo que a forma errada nunca chegue
ao cliente. Os mesmos schemas Zod alimentam o cliente RPC tipado — sem codegen, sem
runtime compartilhado.

### 3. Layout travado

Toda route, service, schema e teste fica em um caminho previsível, encontrável por
glob:

```
src/
├── app.ts                # createApp({ context, modules })
├── context.ts            # defineContext({ ... })
├── middlewares/
└── modules/<domain>/
    ├── <domain>.route.ts     # defineRoute calls only
    ├── <domain>.service.ts   # pure functions
    ├── <domain>.schema.ts    # Zod schemas (DTOs)
    ├── <domain>.hurl         # API E2E
    └── <domain>.test.ts      # unit tests
```

Sem handlers soltos, sem schemas inline. Services são funções puras, sem
imports de framework. Veja [Layout do projeto](/pt/guide/project-layout) para as regras
completas.

::: tip Por que os invariantes importam
DI estática, schemas obrigatórios e um layout travado são exatamente o que o `kata verify`
checa. Como a forma é fixa, a checagem é um glob mais um match de AST — rápido
o bastante para rodar a cada escrita de arquivo e devolver os resultados a um agente como
`hookSpecificOutput.additionalContext` para autocorreção. Veja
[O harness](/pt/guide/harness).
:::

## Para quem é

Os dois públicos, pelo mesmo mecanismo. Humanos ganham uma forma óbvia de escrever uma
route e um verificador que pega o deslize antes da revisão. Agentes ganham uma forma que
conseguem produzir e uma checagem que conseguem ler: quando o `kata verify` falha, ele retorna
feedback estruturado que o agente usa para corrigir a própria saída. As restrições que
tornam o código grepável para uma ferramenta são as mesmas que o tornam previsível para
uma pessoa.

## O que o Kata não é

O Kata é dono da requisição: roteamento tipado, validação obrigatória, injeção de dependência,
o envelope de erro e o ciclo de vida. Ele **não** entrega uma camada de persistência,
um rate limiter, um exportador de métricas, um carregador de config ou helpers de paginação. Isso
é infraestrutura e política de produto — continua sendo seu, para que o framework nunca te
prenda a um fornecedor ou a uma forma. Como `createApp` retorna um app Hono comum,
qualquer middleware do Hono funciona em toda a aplicação hoje.

Essa fronteira é deliberada, não uma lacuna. Veja
[Não-objetivos & traga o seu](/pt/cookbook/non-goals) para o padrão BYO idiomático
de cada um.

## Próximos passos

- [Por que Kata](/pt/guide/why-kata) — o argumento contra as alternativas, por completo.
- [Quickstart](/pt/guide/quickstart) — uma API `/users` totalmente tipada em seis arquivos.
