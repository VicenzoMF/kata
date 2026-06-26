---
title: Services
description: A lógica de negócio vive em funções puras sem imports de framework — trivialmente testáveis em unidade, chamadas a partir dos handlers de route.
---

# Services

Um service é onde a sua lógica de negócio vive. Ele fica em `<domain>.service.ts` e
é feito de funções comuns — e, crucialmente, ele não importa *nada* do
framework: sem `kata`, sem Hono, sem `defineContext`, sem `defineRoute`, sem `c`. Um handler de
route valida o input, chama um service e retorna o resultado. O service em si
não faz ideia de que está sendo servido sobre HTTP.

Essa separação é o sentido de todo o layout travado, e ela organiza os arquivos de cada domínio
por responsabilidade:

- a **route** é o *contrato* (método, path, input/output);
- o **service** é a *lógica*;
- o **schema** é o *formato*.

Cada um é encontrável por glob e testável por conta própria.

Por que insistir que o service seja livre de framework? Porque uma função cujo resultado
depende apenas dos seus argumentos — sem leituras ocultas de um container, sem alcançar o
estado global — é uma função que você pode testar apenas chamando-a, e reutilizar em qualquer lugar, HTTP ou
não. Essa propriedade tem um nome — uma função *pura* — e a maior parte desta página é sobre
protegê-la.

## Um service é só funções

O exemplo `hello` mantém todo o seu store de usuários em um único arquivo. Note o que ele
**não** importa: nada de `kata`, nenhum Hono, nenhum contexto de requisição.

```ts
// src/modules/users/users.service.ts
import type { CreateUserBody, User } from './users.schema'

const store = new Map<string, User>()

export async function getUser(id: string): Promise<User | null> {
  return store.get(id) ?? null
}

export async function createUser(input: CreateUserBody): Promise<User> {
  const id = crypto.randomUUID()
  const user: User = { id, ...input }
  store.set(id, user)
  return user
}
```

Os únicos imports são *tipos* do `<domain>.schema.ts` vizinho. As funções
recebem e retornam esses DTOs tipados, e essa é toda a superfície de dependência — tipos
desaparecem em tempo de compilação, então importá-los não prende o service a nada concreto em
runtime.

::: tip Named exports, sem classes
Services são funções, não métodos em uma classe ([ADR-0002](/adr/0002-no-classes-no-decorators)).
Exporte cada uma pelo nome. Não há objeto de service para instanciar e nenhum `this`
para fazer bind.
:::

## Como as routes chamam os services

Pense no handler como um adaptador fino entre HTTP e a sua lógica. A route detém
as preocupações de HTTP — método, path, `input`, `output`, status codes — e entrega o
trabalho real ao service. O handler lê o `c.input` já validado, chama
o service e retorna o valor (que o Kata então valida contra `output`):

```ts
// src/modules/users/users.route.ts
import { ErrorBodySchema } from 'katajs'

import { defineRoute } from '../../context'

import { CreateUserBodySchema, GetUserParamsSchema, UserSchema } from './users.schema'
import { createUser, getUser } from './users.service'

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

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.input.body),
})
```

Lido de cima a baixo, cada handler é três passos: desempacota `c.input`, chama o service,
mapeia o resultado em uma resposta. Mantenha a validação nos schemas e a lógica no
service, e não sobra quase nada para o handler errar. Veja
[Rotas & schemas](/pt/guide/routes-schemas) para a superfície completa de route.

## Dependências são argumentos, não imports

O store do `hello` é um `Map` em nível de módulo — ótimo para uma demo, mas um service
real precisa de um banco de dados. Aqui está a tensão: o banco de dados vive no container de DI, mas um service
que alcança o container deixa de ser puro. O Kata resolve isso com uma regra:
**um service nunca chama `c.get(...)`.** Em vez disso, ele *recebe* suas dependências como
argumentos comuns, e a route — que tem o `c` — as puxa do contexto
e as passa adiante.

Isso é inversão de dependência dita de forma simples: a assinatura do service diz "Eu preciso de um
`Store`", e o *chamador* decide qual `Store` é esse. O service se compromete com uma
interface, nunca com uma implementação concreta.

O exemplo `shop` faz exatamente isso. O seu service de pedidos recebe um `Store` (ou uma
`Transaction` por requisição) como primeiro parâmetro:

```ts
// src/modules/orders/orders.service.ts
import type { Store, Transaction } from '../../store'

import type { Order } from './orders.schema'

export function listOrders(store: Store, userId: string): Order[] {
  return store.listOrders(userId)
}

export function getOrder(store: Store, userId: string, id: string): Order | undefined {
  const order = store.getOrder(id)
  if (!order || order.userId !== userId) return undefined
  return order
}
```

A route é onde a conexão acontece. `store` é um slot singleton em
`defineContext`; o handler o lê com `c.get('store')` e o entrega ao
service:

```ts
// src/modules/orders/orders.route.ts
export const listOrdersRoute = defineRoute({
  method: 'GET',
  path: '/orders',
  use: [requireAuth],
  input: {},
  output: OrderListSchema,
  handler: (c) => listOrders(c.get('store'), c.get('currentUser').id),
})
```

Então `c.get('store')` e `c.get('currentUser')` ficam no handler, onde o contexto
realmente existe; o service enxerga apenas um `Store` e um `userId`. A recompensa vem
quando você troca o store em memória por um banco de dados real: a assinatura do service não
muda em nada — apenas o singleton que você registra.

## Retorne resultados, não respostas

Um service não tem `c`, então ele não pode chamar `c.json(...)` nem `c.error(...)` — e isso é
uma feature, não uma limitação. Status codes HTTP são um detalhe de transporte; o trabalho do
service é reportar *o que aconteceu* e deixar a route decidir como isso é mapeado para a
rede.

Quando uma operação pode falhar de um jeito sobre o qual o chamador precisa ramificar, o movimento idiomático é
retornar uma **união discriminada** — um tipo que é uma de várias formas nomeadas, cada
uma etiquetada por um campo compartilhado (aqui `ok`, mais um código de `error` nas falhas). O chamador
faz switch nessa etiqueta, e o TypeScript garante que cada caso seja tratado.

O `checkout` do `shop` retorna uma:

```ts
// src/modules/orders/orders.service.ts
export type CheckoutResult =
  | { ok: true; order: Order }
  | { ok: false; error: 'cart_empty' }
  | { ok: false; error: 'product_unavailable'; productId: string }
  | {
      ok: false
      error: 'insufficient_stock'
      productId: string
      available: number
      requested: number
    }

export function checkout(tx: Transaction, userId: string): CheckoutResult {
  const cartLines = tx.getCart(userId)
  if (cartLines.length === 0) return { ok: false, error: 'cart_empty' }
  // ... prepara as baixas de estoque, monta o pedido ...
  return { ok: true, order }
}
```

O handler mapeia essa união no wire — sucesso para `201`, cada falha para
o seu status via o envelope de erro unificado ([ADR-0008](/adr/0008-unified-error-response-envelope)):

```ts
// src/modules/orders/orders.route.ts
handler: (c) => {
  const tx = c.get('tx')
  const result = checkout(tx, c.get('currentUser').id)
  if (!result.ok) {
    const envelope = describeCheckoutFailure(result)
    return c.error(envelope.code, envelope.message, { status: envelope.status })
  }
  const committed = tx.commit()
  if (!committed.ok) {
    return c.error(
      'stock_conflict',
      `Stock for "${committed.conflict}" changed during checkout — please retry`,
      { status: 409 },
    )
  }
  return c.json(result.order, 201)
}
```

O mapeamento em si — `describeCheckoutFailure` — *também* é uma função pura no
mesmo service, então até o contrato de erro é testável em unidade, sem nenhum `c` à vista. As
partes específicas de HTTP (`c.error`, o literal `201`) são as únicas coisas que permanecem na
route. Veja [Erros](/pt/guide/errors) para o envelope.

## Services são trivialmente testáveis

Tudo acima compensa aqui. Como um service não importa framework nenhum e recebe suas
dependências como argumentos, um teste apenas importa as funções e as chama — nenhum app
para iniciar, nenhuma requisição para forjar, nenhum mock de `c`. O arquivo de teste é
`<domain>.service.test.ts`, localizado bem ao lado do service.

O teste do service `hello` chama as funções reais diretamente:

```ts
// src/modules/users/users.service.test.ts
import { describe, expect, it } from 'vitest'

import { createUser, getUser } from './users.service'

describe('users.service', () => {
  it('createUser persists and returns the user with a uuid id', async () => {
    const user = await createUser({ name: 'Alice', email: 'a@example.com' })
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(user.name).toBe('Alice')
    expect(user.email).toBe('a@example.com')
  })

  it('getUser returns null for unknown ids', async () => {
    expect(await getUser('does-not-exist')).toBeNull()
  })
})
```

Quando um service recebe uma dependência, o teste constrói uma *de verdade* e a passa
adiante — sem necessidade de framework de mocking. O teste do `shop` monta um store em memória com
um catálogo semente, depois faz asserções tanto sobre a união retornada quanto sobre o estado do store:

```ts
// src/modules/orders/orders.service.test.ts
import { describe, expect, it } from 'vitest'

import { createStore } from '../../store'
import { addItem } from '../cart/cart.service'
import { checkout, listOrders } from './orders.service'

describe('orders.service checkout', () => {
  it('decrements stock, creates an order, and clears the cart on commit', () => {
    const store = createStore([{ id: 'mouse', name: 'Mouse', priceCents: 4500, stock: 10 }])
    addItem(store, 'u1', { productId: 'mouse', qty: 2 })

    const tx = store.begin()
    const result = checkout(tx, 'u1')
    if (!result.ok) throw new Error('expected ok')
    tx.commit()

    expect(result.order.totalCents).toBe(2 * 4500)
    expect(store.getProduct('mouse')?.stock).toBe(8)
    expect(listOrders(store, 'u1').map((o) => o.id)).toEqual([result.order.id])
  })

  it('rejects an empty cart', () => {
    expect(checkout(createStore([]).begin(), 'u1')).toEqual({ ok: false, error: 'cart_empty' })
  })
})
```

A regra de negócio inteira — baixa de estoque, checkout atômico, posse, o envelope
de erro — é exercitada sem nunca tocar no HTTP. Rode-a com `pnpm test`.

::: info Puro por construção
Manter `c.get(...)` na route e fora do service é exatamente o que torna isso
possível. Se um service alcançasse o container, você teria que forjar o
container para testá-lo. Passar a dependência adiante mantém cada teste como uma simples chamada de
função.
:::

## Persistência é bring-your-own

O Kata não traz uma camada de banco de dados, nenhum ORM e nenhuns helpers de query — persistência é um
não-objetivo deliberado ([Não-objetivos](/pt/cookbook/non-goals)). Ambos os exemplos usam um
store em memória como substituto. O padrão que mantém a troca eventual indolor é
o mesmo de antes: modele o seu acesso a dados como um cliente tipado, registre-o como um
slot `singleton` e passe-o para os services como argumento.

Então, quando você substituir o `Store` em memória por node-postgres, Drizzle, Prisma ou
qualquer outra coisa, apenas o singleton que você registra em `defineContext` muda — cada
assinatura de service e cada handler de route permanece o mesmo. A receita completa está
em [Banco de dados](/pt/cookbook/database).

## Regras

- Um service importa tipos de `<domain>.schema.ts` e de outros services. Nada
  de `kata`, Hono ou do contexto de requisição.
- Um service nunca chama `c.get(...)`, `c.json(...)` ou `c.error(...)`. Ele recebe
  dependências como argumentos e retorna valores comuns ou uniões de resultado tipadas.
- Services são funções com named exports — sem classes, sem `this`
  ([ADR-0002](/adr/0002-no-classes-no-decorators)).
- Todo service tem um `<domain>.service.test.ts` vizinho. Ele deve rodar sem
  iniciar o app.

Veja também: [Rotas & schemas](/pt/guide/routes-schemas),
[Context & DI](/pt/guide/context-di), [Layout do projeto](/pt/guide/project-layout).
