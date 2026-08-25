# Receita: Correlacionando logs da camada de service

**Problema:** toda requisição ganha um id de correlação — `c.requestId` — mas uma
função em `<domain>.service.ts` é uma [função pura](/pt/guide/services), sem
imports do framework e sem `c`. Se um service quer logar algo, como essa linha de
log acaba marcada com o mesmo `requestId` da linha de log da própria requisição,
sem passar manualmente um `requestId` extra por toda assinatura de service?
([#249](https://github.com/VicenzoMF/kata/issues/249))

**Padrão:** não há nenhum mecanismo novo para aprender aqui — isso é a regra já
existente ["dependências são argumentos, não imports"](/pt/guide/services#dependencias-sao-argumentos-nao-imports),
aplicada ao singleton `logger`. O handler da route é o único lugar que já possui
as duas metades da correlação — `c.get('logger')` e `c.requestId` — então ele
constrói um pequeno **logger vinculado à requisição** (um objeto simples que fecha
sobre os dois) e passa *esse* logger ao service como um argumento comum, exatamente
como faz com `store` ou `tx`. O service continua sem importar nada do framework;
ele só recebe um valor com a forma de um logger, em vez de um `Logger` puro.

## 1. O id vive em `c`, não no registry

`c.requestId` é um campo do framework no contexto de requisição/middleware, não um
slot `scoped<T>()` ([ADR-0004](/adr/0004-di-via-scoped-slots); veja o comentário de
doc de `requestId` em `RouteContext` no
[`context.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/context.ts)).
Isso é deliberado — é contexto de requisição selado e de propósito único, como
`c.raw`, não um valor de DI geral — mas também significa que um service, que nunca
enxerga `c`, não tem como lê-lo sozinho. O único caminho de entrada é o mesmo de
qualquer outra dependência: a route o lê e o repassa.

## 2. Vincule o logger uma vez, na route

Escreva um pequeno helper que envolve um `Logger` para que toda chamada carregue
automaticamente um `requestId` fixo. Ele vive na raiz de `src/` — território aberto
para infraestrutura compartilhada e não-HTTP
([Layout do projeto](/pt/guide/project-layout#a-raiz-de-src)), ao lado de coisas
como `src/db.ts` ou `src/store.ts`.

```ts
// src/logging.ts
import type { Logger, LogExtra } from '@katajs-framework/core'

/** A forma de logger que um service recebe — idêntica ao `Logger` do framework. */
export type ServiceLogger = Logger

/**
 * Envolve um singleton `logger` para que toda chamada carregue automaticamente
 * o id de correlação desta requisição. Construa um por requisição no handler
 * da route e passe-o aos services como um argumento comum (veja o exemplo do
 * `checkout` abaixo). `warn`/`error` caem para `info` — a mesma degradação que
 * `logRequest` usa internamente — então um logger de um único método ainda
 * funciona.
 */
export function withRequestId(logger: Logger, requestId: string): ServiceLogger {
  const tag = (extra?: LogExtra): LogExtra => ({ ...extra, requestId })
  return {
    info: (message, extra) => logger.info(message, tag(extra)),
    warn: (message, extra) => (logger.warn ?? logger.info)(message, tag(extra)),
    error: (message, extra) => (logger.error ?? logger.info)(message, tag(extra)),
  }
}
```

`Logger` e `LogExtra` são exportados por `@katajs-framework/core` exatamente para
isso — tipar seu próprio logger e pequenos wrappers em torno dele (veja a tabela de
tipos do [`@katajs-framework/core`](/pt/reference/)). Importá-los aqui é normal:
`src/logging.ts` é código de app na raiz, não um arquivo `<domain>.service.ts`, então
não está sujeito à regra de "nenhum import do framework" que vale dentro de
`modules/`.

## 3. Passe o logger vinculado ao service como qualquer outra dependência

A assinatura do service ganha mais um parâmetro comum — não é diferente, em
natureza, do `tx` ou do `userId` que ela já recebe. Estendendo o `checkout` do
[`shop`](https://github.com/VicenzoMF/kata/blob/main/examples/shop/src/modules/orders/orders.service.ts):

```ts
// src/modules/orders/orders.service.ts
import type { ServiceLogger } from '../../logging'
import type { Store, Transaction } from '../../store'

import type { Order, OrderLine } from './orders.schema'

// ...CheckoutResult, CheckoutFailure, CheckoutErrorEnvelope sem mudanças...

export function checkout(tx: Transaction, userId: string, logger: ServiceLogger): CheckoutResult {
  const cartLines = tx.getCart(userId)
  if (cartLines.length === 0) {
    logger.warn('checkout rejected: empty cart', { userId })
    return { ok: false, error: 'cart_empty' }
  }

  // ...decrementos de estoque, montagem de orderLines, exatamente como antes...

  const order: Order = {
    id: crypto.randomUUID(),
    userId,
    lines: orderLines,
    totalCents: orderLines.reduce((sum, line) => sum + line.unitPriceCents * line.qty, 0),
    status: 'paid',
    createdAt: new Date().toISOString(),
  }
  tx.putOrder(order)
  tx.setCart(userId, [])
  logger.info('checkout succeeded', { userId, orderId: order.id, totalCents: order.totalCents })
  return { ok: true, order }
}
```

`checkout` continua sem importar nada do framework — `ServiceLogger` é um tipo
vindo de `../../logging`, um arquivo do app, do mesmo jeito que `Store`/`Transaction`
vêm de `../../store`. A route constrói o logger vinculado uma vez, a partir de
peças que já tem, e o repassa adiante:

```ts
// src/modules/orders/orders.route.ts
import { withRequestId } from '../../logging'
// ...outros imports sem mudanças...

export const checkoutRoute = defineRoute({
  method: 'POST',
  path: '/orders',
  use: [requireAuth, withTransaction],
  input: {},
  output: { 201: OrderSchema, 409: ErrorBodySchema, 422: ErrorBodySchema },
  handler: (c) => {
    const tx = c.get('tx')
    const logger = withRequestId(c.get('logger'), c.requestId)
    const result = checkout(tx, c.get('currentUser').id, logger)
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
  },
})
```

Toda linha de log que `checkout` emite agora carrega o mesmo `requestId` da
própria linha de log por requisição do framework
([issue #63](https://github.com/VicenzoMF/kata/issues/63)) e do header de resposta
`X-Request-Id` — um único id, não importa de onde a linha veio.

## 4. Teste sem uma requisição

Como o service continua apenas recebendo um argumento, o teste passa um
`ServiceLogger` falso e verifica o que foi capturado — sem app, sem `c`, sem um
`requestId` de verdade à vista:

```ts
// src/modules/orders/orders.test.ts
import { describe, expect, it } from 'vitest'

import type { ServiceLogger } from '../../logging'
import { createStore } from '../../store'
import { addItem } from '../cart/cart.service'
import { checkout } from './orders.service'

function fakeLogger(): ServiceLogger & { calls: Array<{ level: string; message: string }> } {
  const calls: Array<{ level: string; message: string }> = []
  return {
    calls,
    info: (message) => calls.push({ level: 'info', message }),
    warn: (message) => calls.push({ level: 'warn', message }),
    error: (message) => calls.push({ level: 'error', message }),
  }
}

it('logs a warning when the cart is empty', () => {
  const logger = fakeLogger()
  checkout(createStore([]).begin(), 'u1', logger)
  expect(logger.calls).toEqual([{ level: 'warn', message: 'checkout rejected: empty cart' }])
})
```

## Por que isso não reabre o ADR-0004

O ADR-0004 rege *como estado por requisição entra em `c.get(...)`* — o mecanismo
de slots, e a regra de que nada fora dele contrabandeia estado por requisição para
dentro de um handler. Esta receita nunca toca nesse mecanismo: `withRequestId`
constrói um valor comum (um closure sobre um singleton e uma string) na route, e a
route o passa ao service exatamente do mesmo jeito que passa `store`, `tx`, ou
`c.get('currentUser').id` — um argumento de função comum, decidido inteiramente
pelo chamador. Nenhum slot scoped novo, nenhum service alcançando o registry, nada
com escopo de requisição vivendo em lugar nenhum além das variáveis locais da
route. Um service que recebe um logger vinculado não consegue distingui-lo de
qualquer outro valor com a forma de `Logger` que você tenha construído à mão num
teste.

## Pegadinhas

- **Construa o logger vinculado na route, uma vez por requisição** — não dentro
  do service, e não chamando `withRequestId` mais de uma vez por requisição.
  Chamá-lo dentro do service significaria importar lógica de `c.requestId` para
  dentro de um arquivo que deveria não saber nada sobre HTTP.
- **`ServiceLogger` é estrutural, não um tipo marcador.** Qualquer objeto com
  `info`/`warn`/`error` na forma certa satisfaz o tipo — incluindo o fake do passo
  4 — então os testes nunca precisam do `Logger` real do framework nem de uma
  biblioteca de mocks.
- **Isso é opcional.** Um service sem necessidade de log não recebe parâmetro de
  logger algum; nada muda nas routes ou middlewares. Adicione o argumento só aos
  services que de fato logam.
- **Se um service é chamado por mais de uma route**, cada ponto de chamada
  constrói e passa seu próprio logger vinculado — não há uma instância
  compartilhada por service que possa acidentalmente reaproveitar um `requestId`
  velho de uma requisição anterior.
