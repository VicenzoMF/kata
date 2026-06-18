---
title: O que é Kata
description: Uma camada fina e opinativa sobre o Hono — funcional, completa em schemas e verificável mecanicamente.
---

# O que é Kata

Kata é uma camada fina e opinativa sobre o [Hono](https://hono.dev). O Hono te dá
o roteador, os adaptadores cross-runtime e o cliente RPC tipado. O Kata adiciona
a parte que o Hono deixa em aberto: **como você estrutura uma aplicação, de onde vêm
as dependências e como uma route pode se parecer.**

> Opinativo como o NestJS, funcional como um script, verificável como um sistema
> de tipos. Construído para que agentes de IA e humanos produzam código correto na
> primeira tentativa.

O nome é a tese. Um _kata_ é uma forma disciplinada e treinada — e `型`
também significa *tipo* e *molde*. Kata é um molde para código de backend: uma forma,
repetida até virar automática, a mesma independentemente de quem escreve, humano ou agente.

## Uma camada fina, não uma reescrita

**O Kata envolve o Hono; ele não o substitui.** Ele constrói sobre o roteador e o
context do Hono, mas nunca reexporta a API do Hono. Toda a superfície pública são quatro
funções — `defineContext`, `defineRoute`, `defineMiddleware`, `createApp` —
mais o cliente RPC do Hono: a peça que permite a um chamador TypeScript atingir sua API e
obter de volta os tipos *exatos* de requisição e resposta do servidor, sem codegen e sem
um cliente construído separadamente ([ADR-0001](/adr/0001-use-hono-as-base)). Todo o resto
é um objeto comum que você passa para uma dessas quatro funções.

```ts
import { defineContext, scoped, singleton } from 'kata'

export const k = defineContext({
  logger: singleton(console),
  currentUser: scoped<{ id: string }>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

`defineContext` é a raiz de tudo. Você entrega a ele seu registry de dependências,
e ele te devolve `defineRoute`, `defineMiddleware` e `createApp` — já
vinculados a esse registry, de modo que o resto da sua aplicação herda os tipos de graça.

Como o Kata fica *sobre* o Hono em vez de escondê-lo, duas coisas se seguem:

- Ele roda onde quer que o Hono rode — Node, Bun, Deno, edge.
- A aplicação que `createApp` retorna é um app Hono de verdade que você pode estender.

## Apenas funcional

O Kata não tem classes, não tem decorators e não tem container IoC em runtime
([ADR-0002](/adr/0002-no-classes-no-decorators)). Todo o vocabulário é
menor que isso:

- Uma route é `defineRoute({...})` — e nada mais.
- Uma dependência é uma entrada em `defineContext`.

Não existe `@Injectable()`, nem reflection de metadados, nem cadeia de herança para
rastrear.

Isso não é nostalgia — é o que torna o código verificável por uma ferramenta.
Decorators no estilo NestJS escondem um fluxo de controle que é difícil de buscar com grep e difícil de
verificar: os metadados rodam no momento da decoração, o container resolve em runtime,
e nenhum dos dois é visível no código-fonte que você está lendo. O Kata aposta no caminho oposto
— **restrições ajudam agentes.** Funções, objetos comuns e imports explícitos podem
ser inspecionados por uma máquina, não só por um humano.

Duas regras decorrem dessa aposta, e o Kata impõe ambas: apenas exports nomeados, e
sem `any` (use `unknown` e faça narrowing).

## Três invariantes

O Kata impõe três regras. Juntas, elas tornam uma aplicação *mecanicamente verificável* —
o que significa que um programa, não apenas um revisor humano, pode confirmar que as regras se mantêm.
Concretamente, essa checagem é um passe de lint em um hook `PostToolUse`: menos de 100ms, sem subir
a aplicação.

### 1. DI estática

Toda dependência é declarada em um único `defineContext({...})`. Uma dependência é
um de dois tipos de slot:

- `singleton(value)` — um valor para todo o processo (um pool de banco, um logger, um
  mailer).
- `scoped<T>()` — um valor por requisição, preenchido por um middleware (o usuário
  atual, um id de tenant, uma transação).

`c.get('key')` só passa na checagem de tipos para uma key que você efetivamente registrou. Nada
escapa do sistema de tipos através de buscas por chave em string, então o grafo completo de dependências
pode ser lido a partir de um único arquivo ([ADR-0004](/adr/0004-di-via-scoped-slots)).

### 2. Schemas obrigatórios

Toda route declara tanto um schema de `input` quanto de `output`. Omitir qualquer um deles
é um erro de TypeScript, não uma surpresa em runtime
([ADR-0003](/adr/0003-mandatory-input-output-schemas)).

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

Esses dois schemas protegem ambas as extremidades do handler:

- **`input` é verificado antes do handler rodar.** Em caso de falha o Kata retorna `422`
  com um envelope normalizado `{ error: "validation_failed", issues }` — o seu código
  nunca vê um input ruim.
- **`output` é verificado depois que o handler retorna.** Uma divergência é logada e
  convertida em `500 { "error": "internal_output_shape_mismatch" }`, de modo que a forma
  errada nunca chegue ao cliente.

Os mesmos schemas Zod também alimentam o cliente RPC tipado — sem codegen, sem
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
checa. Como a forma é fixa, a checagem é apenas um glob mais um match de AST —
rápido o bastante para rodar a cada escrita de arquivo e devolver o resultado direto a um
agente como `hookSpecificOutput.additionalContext` para autocorreção. Veja
[O harness](/pt/guide/harness).
:::

## Para quem é

Humanos e agentes — servidos pelo mesmo mecanismo, não dois diferentes.

- **Humanos** ganham uma forma óbvia de escrever uma route, e um verificador que pega
  o deslize antes da revisão.
- **Agentes** ganham uma forma que conseguem produzir de maneira confiável e uma checagem
  que conseguem ler: quando o `kata verify` falha, ele retorna feedback estruturado que o
  agente usa para corrigir a própria saída.

As restrições que tornam o código grepável para uma ferramenta são as mesmas que o
tornam previsível para uma pessoa. Essa sobreposição é todo o design.

## O que o Kata não é

O Kata é dono da requisição — e para por aí. Dentro de suas fronteiras: roteamento tipado,
validação obrigatória, injeção de dependência, o envelope de erro e o ciclo de
vida. Fora delas, de propósito: **nenhuma camada de persistência, nenhum rate limiter, nenhum
exportador de métricas, nenhum carregador de config, nenhuns helpers de paginação.**

Essas coisas são infraestrutura e política de produto. Elas continuam sendo suas, para que o framework
nunca te prenda a um fornecedor ou a uma forma. E como `createApp` retorna um app
Hono comum, qualquer middleware do Hono funciona em toda a aplicação hoje.

Essa fronteira é deliberada, não uma lacuna. Veja
[Não-objetivos & traga o seu](/pt/cookbook/non-goals) para o padrão BYO idiomático
de cada um.

## Próximos passos

- [Por que Kata](/pt/guide/why-kata) — o argumento contra as alternativas, por completo.
- [Quickstart](/pt/guide/quickstart) — uma API `/users` totalmente tipada em seis arquivos.
