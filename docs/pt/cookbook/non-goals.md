# Receita: Não-objetivos e traga-o-seu-próprio

**Problema:** você procura a camada de persistência embutida do Kata, o rate
limiter, o exportador de métricas, o carregador de config ou o helper de
paginação — e não existe nenhum. Isso é uma lacuna?

**Padrão:** não — é a fronteira. O Kata é dono da requisição: roteamento tipado,
validação obrigatória de `input` / `output`, injeção de dependência, o error
envelope e o ciclo de vida. *Infraestrutura* e *política de produto* — como você
armazena dados, limita tráfego, mede, configura e pagina — continuam sendo seus,
então o framework nunca te prende a um fornecedor ou a um formato. Esta é a linha
da v0.3, de propósito: persistência, rate-limit, métricas, env e paginação são
**traga-o-seu-próprio (BYO)**, não funcionalidades faltando. Abaixo está o BYO
idiomático para cada um, e a alavanca em que ele se apoia.

Cada trecho aqui usa apenas a superfície já entregue do Kata
([`packages/kata/src/index.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/index.ts)) e os apps
executáveis [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop) / [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello).
Onde uma receita se apoia em API planejada, ela é rotulada como _Planejado_ com sua
issue de rastreamento — nunca assuma que a API planejada já funciona.

## A fronteira

| O Kata é dono (na caixa) | Você traz (BYO) |
|---|---|
| Roteamento tipado; schemas Zod de `input` / `output` por rota ([ADR-0003](/adr/0003-mandatory-input-output-schemas)) | Persistência (SQL / NoSQL) |
| DI — slots `singleton` / `scoped` em um único `defineContext` ([ADR-0004](/adr/0004-di-via-scoped-slots)) | Rate limiting / throttling |
| O error envelope unificado + a fronteira global de erros ([ADR-0008](/adr/0008-unified-error-response-envelope)) | Métricas / tracing |
| Ciclo de vida da requisição — `x-request-id`, a linha de log por requisição | Validação de env / config |
| Hardening embrulhado pelo Hono: `cors()`, `secureHeaders()`, `bodyLimit()` | Paginação / filtragem / ordenação |

Cada linha de BYO usa uma de três alavancas que você já tem:

- **Um slot singleton** — um cliente de vida longa (pool, SDK, exportador), um por
  processo; `c.get('key')` retorna a mesma instância em todo lugar ([database.md](/pt/cookbook/database)).
- **Um slot scoped** — estado por requisição (uma transação, um span), definido por
  um middleware ([auth.md](/pt/cookbook/auth)).
- **Um middleware Hono** — `createApp` retorna um app Hono puro, então
  `app.use('*', mw)` aplica qualquer middleware Hono em todo o app, hoje.

Nenhuma dessas é uma funcionalidade de framework que você está esperando. Esse é o
ponto: o núcleo permanece pequeno e estaticamente verificável, e as escolhas que
dependem da sua infraestrutura permanecem com você.

## 1. Persistência (SQL / NoSQL)

**Padrão:** o pool de conexão / cliente é um **singleton**; uma transação é um slot
**scoped**, aberto e commitado (ou revertido) por um middleware. É a mesma divisão
de dois tempos de vida de [database.md](/pt/cookbook/database) — `c.get('store')` é o
pool de vida longa, `c.get('tx')` é a transação desta requisição — e ela vem
executável em [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop), onde o checkout decrementa
o estoque, grava o pedido e limpa o carrinho atomicamente.

```ts
// examples/shop/src/context.ts (trecho)
export const k = defineContext({
  store: singleton<Store>(createStore()), // pool / cliente — um por processo
  tx: scoped<Transaction>(),              // uma transação por requisição
})
```

O middleware abre a transação a partir do singleton, a fornece como um slot scoped,
e garante o rollback em qualquer caminho que não faça commit:

```ts
// examples/shop/src/middlewares/transaction.ts
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
    // Alcançado só se o handler retornou sem commitar (ex.: c.error).
    if (tx.status === 'open') tx.rollback()
  },
})
```

Anexe-o às rotas que precisam de uma transação; o handler lê `c.get('tx')`,
encadeia suas gravações e faz commit no sucesso:

```ts
// examples/shop/src/modules/orders/orders.route.ts (trecho)
export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction], // a ordem é o contrato — auth, depois tx
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx')
    const result = checkout(tx, c.get('currentUser').id)
    // ...commit no sucesso; uma resposta de erro deixa o middleware reverter.
  },
})
```

**Seu driver, sua decisão.** Qualquer coisa que exponha um pool mais uma superfície
`begin / commit / rollback` se encaixa nesse formato:

| Driver | Encaixe |
|---|---|
| `node-postgres` (`pg`), `postgres.js` | ideal — um pool puro com `BEGIN` / `COMMIT` explícitos |
| Drizzle, Kysely | ideal — query builders tipados; `db.transaction(...)` mapeia no slot scoped |
| Prisma | funciona — passe o cliente `prisma.$transaction(...)` pelo slot `tx` |
| TypeORM, MikroORM | funcionam, mas o modelo de decorator/entity deles atrita com a [ADR-0002](/adr/0002-no-classes-no-decorators) — prefira um driver sem decorators |

> NoSQL é a mesma regra: a conexão é um singleton, e handles com escopo de
> requisição (uma session do MongoDB, um `MULTI` do Redis) são slots scoped
> definidos por um middleware. O modelo de tempo de vida — não SQL — é o que o Kata
> padroniza.

Veja [database.md](/pt/cookbook/database) para o passo a passo completo de singleton +
service puro, e o
[middleware de transação de `examples/shop`](https://github.com/VicenzoMF/kata/blob/main/examples/shop/src/middlewares/transaction.ts)
para a fiação completa de commit/rollback.

## 2. Rate limiting / throttling

**Padrão:** um middleware Hono. Throttling é transversal e específico do backend
(em memória para um nó, Redis para uma frota, ou o gateway na sua frente), então o
Kata não entrega nenhum limiter — você escolhe o store e aplica um middleware Hono
no app que `createApp` retorna. Em todo o app costuma ser exatamente onde você o
quer:

```ts
// src/main.ts
import { serve } from '@hono/node-server'
import { rateLimiter } from 'hono-rate-limiter' // ex. — escolha seu limiter + store

import { createApp } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })

// Aplica a toda rota — Hono puro no app que o Kata devolve.
app.use('*', rateLimiter({ windowMs: 60_000, limit: 100 }))

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) })
```

Os próprios `cors()`, `secureHeaders()` e `bodyLimit()` do Kata
([`packages/kata/src/middlewares/`](https://github.com/VicenzoMF/kata/tree/main/packages/kata/src/middlewares)) mostram o
formato — middleware Hono adaptado ao contrato `Middleware` do Kata — e um limiter que
você embrulha da mesma forma se encaixa ao lado deles: na cadeia `use:` de uma única
rota ou, para um limite em todo o app, na cadeia global `createApp({ middlewares })`
([ADR-0012](/adr/0012-app-level-middleware)).

> **Entregue:** a API de middleware de nível de app já chegou
> ([Epic #84](https://github.com/VicenzoMF/kata/issues/84),
> [ADR-0012](/adr/0012-app-level-middleware)) — declare preocupações transversais
> uma vez em `createApp({ middlewares: [...] })` e elas rodam antes do `use:` de cada
> rota. Um limiter nativo do Kata (um valor `Middleware`) entra direto;
> `app.use('*', …)` na instância Hono retornada ainda funciona para middleware Hono
> arbitrário.

## 3. Métricas / tracing

**Padrão:** a mesma junção de nível de app, apontada para qualquer backend que você
já rode (OpenTelemetry, Prometheus, Datadog…). O Kata permanece neutro quanto a
fornecedor e te dá dois hooks em vez de um exportador fixo:

```ts
// src/main.ts
import { otel } from '@hono/otel' // ex. — qualquer middleware de instrumentação Hono

const app = createApp({ modules: [users] })
app.use('*', otel()) // um span por requisição para o seu exportador configurado
```

- **O exportador/SDK é um singleton.** Construa o cliente de métricas (um exportador
  OTLP, um socket StatsD) uma vez em `defineContext` e faça `c.get('metrics')` nos
  handlers para contadores customizados — a mesma regra de tempo de vida de processo
  do pool do banco ([database.md](/pt/cookbook/database#why-singleton-not-scoped)).
- **A correlação já está fiada.** O Kata reaproveita um `x-request-id` de entrada
  (definido pelo seu proxy ou gateway) ou cunha um, o ecoa na resposta, e marca a
  linha de log por requisição com ele (`REQUEST_ID_HEADER`). Envie esse header na sua
  borda e seus traces, logs e a própria linha de log do Kata compartilham todos um
  id — sem um segundo id de correlação para inventar.

## 4. Validação de env / config

**Padrão:** não há nada a entregar — validação de config *é* Zod, do qual o Kata já
depende. Faça parse de `process.env` uma vez, na borda, em um objeto tipado;
importe esse objeto em todo lugar em vez de tocar em `process.env` de novo.

```ts
// src/env.ts
import { z } from 'zod'

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

// Lança no momento do import com uma mensagem precisa se o ambiente estiver errado.
export const env = EnvSchema.parse(process.env)
```

```ts
// src/context.ts
import { env } from './env'

export const k = defineContext({
  db: singleton(makeDb(env)), // config tipada na entrada; handlers nunca leem process.env
})
```

Por que uma linha basta:

- **Falhe rápido.** `.parse` lança antes de o servidor abrir uma porta — uma var
  faltando é um crash de inicialização, não um `undefined` às 3 da manhã.
- **Tipado em todo lugar.** `env.PORT` é `number`, `env.DATABASE_URL` é `string` —
  a mesma inferência que você obtém no `input` de uma rota.
- **Uma única fonte da verdade.** Leia na borda, passe os valores para baixo;
  services e handlers permanecem puros e testáveis (a regra de
  [database.md](/pt/cookbook/database#gotchas)).
- **Coerção é embutida.** `z.coerce.number()`, `.default()` e `.enum()` lidam com a
  realidade só-de-strings de `process.env`.

É a mesma biblioteca e o mesmo idioma que o Kata já exige para o `input` da
requisição ([ADR-0003](/adr/0003-mandatory-input-output-schemas)), aplicado ao
ambiente em vez do corpo.

## 5. Paginação, filtragem, ordenação

**Padrão:** uma preocupação de aplicação, não de framework. Um endpoint de listagem
declara seu contrato de query como um schema `input.query`, e um **service puro** o
aplica — exatamente como qualquer outra rota. Não existe um decorator `@Paginate()`
porque não há nada para o framework decidir: o formato de uma página é a decisão do
seu produto. [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop) já faz a metade da filtragem:

```ts
// examples/shop/src/modules/products/products.schema.ts
export const ListProductsQuerySchema = z.object({
  inStock: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
})
```

```ts
// examples/shop/src/modules/products/products.route.ts
export const listProductsRoute = defineRoute({
  method: 'GET',
  path: '/products',
  input: { query: ListProductsQuerySchema },
  output: ProductListSchema,
  handler: (c) => listProducts(c.get('store'), { inStock: c.input.query.inStock }),
})
```

Paginação e ordenação são o mesmo formato com mais campos — adicione-os ao schema de
query, retorne um envelope de página, e deixe o service puro traduzi-los nos
`LIMIT` / `WHERE` / `ORDER BY` do seu driver:

```ts
// adicione ao DTO de query — paginação por keyset + um sort em whitelist
export const ListProductsQuerySchema = z.object({
  inStock: z.enum(['true', 'false']).optional().transform(/* …como acima… */),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  sort: z.enum(['price', '-price', 'name']).default('name'),
})

export const ProductPageSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
})
```

Você herda as garantias do framework de graça: a query é validada e coagida antes do
handler rodar, o formato da página é validado na saída
([ADR-0009](/adr/0009-output-validation-mode)), e o todo é tipado de ponta a ponta
para o cliente RPC `hc`. Offset, keyset ou número-de-página — escolha por endpoint;
o Kata só insiste em que o contrato seja declarado.

## A mesma fronteira, em outros lugares

As cinco acima são as comuns, mas a regra generaliza: se uma preocupação é sobre
*infraestrutura ou política de produto* em vez de *o formato de uma requisição*, o
Kata deixa para você.

- **OpenAPI / documentação de API.** Toda rota já carrega schemas Zod de `input` /
  `output`, então um documento OpenAPI é um passo de geração sobre dados que o Kata
  já tem — não uma lacuna de roadmap. Alimente esses schemas a um gerador (ex.
  `@asteasolutions/zod-to-openapi` ou `@hono/zod-openapi`) e sirva o resultado
  como uma rota ou via `app.use`. O Kata deliberadamente não embute um gerador nem
  é dono do seu pipeline de docs. (Esta é a leitura BYO da linha OpenAPI em
  [migrating-from-nestjs.md](/pt/cookbook/migrating-from-nestjs#what-kata-intentionally-does-not-have).)
- **Jobs em background / filas, e-mail, armazenamento de arquivos, feature flags** —
  a mesma história: um cliente singleton em `defineContext`, consumido a partir de
  services puros.

## Veja também

- [Acesso a banco de dados](/pt/cookbook/database) — singletons, transações scoped,
  services puros, testes com cliente fake.
- [Autenticação](/pt/cookbook/auth) — o mecanismo de scoped slot que os padrões BYO
  reaproveitam.
- [Migrando do NestJS para o Kata](/pt/cookbook/migrating-from-nestjs) — o que mais o
  Kata intencionalmente não tem, e por quê.
- [`examples/shop`](https://github.com/VicenzoMF/kata/tree/main/examples/shop) — o código executável de transação +
  filtro de query que esta página cita.
- ADRs: [0002 (sem classes/decorators)](/adr/0002-no-classes-no-decorators),
  [0003 (schemas obrigatórios)](/adr/0003-mandatory-input-output-schemas),
  [0004 (DI via slots)](/adr/0004-di-via-scoped-slots),
  [0012 (middleware de nível de app)](/adr/0012-app-level-middleware).
