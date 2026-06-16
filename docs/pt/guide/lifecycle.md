---
title: Ciclo de vida e graceful shutdown
description: Sirva uma app Kata no Node e drene as requisições em andamento no SIGTERM com gracefulShutdown de kata/node.
---

# Ciclo de vida e graceful shutdown

Uma app Kata não tem ciclo de vida de plugins, não tem hooks `onStart`/`onError`,
e não tem container de IoC para desmontar. Singletons são eager: uma factory como
`singleton(makeDb(env))` roda quando `context.ts` é importado, e o valor vive pelo
processo inteiro. Resta uma única coisa sob sua responsabilidade — parar o processo
*de forma limpa* quando o orquestrador pedir. Isso é o `gracefulShutdown` de
`kata/node`.

`createApp` não toca no processo. Ele não instala nenhum signal handler, não abre
nenhum socket e não sabe nada sobre Node. Construir uma app é uma operação sem
efeitos colaterais. Servi-la, e desligá-la, é tarefa do `main.ts`.

## Servindo a app

Kata não traz um servidor HTTP. A app é um request handler — `app.fetch` — e você
o entrega a um adaptador de runtime. No Node esse adaptador é
[`@hono/node-server`](https://github.com/honojs/node-server), um peer que você
instala por conta própria; o `serve()` dele é dono do socket de escuta.

```ts
// src/main.ts
import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })
const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

`createApp` retorna uma app Hono paramétrica; `app.fetch` é o handler `Request` →
`Response` dela. Veja [/pt/reference/create-app](/pt/reference/create-app) para a
config que ele aceita.

## Por que graceful shutdown

`serve()` retorna um `Server` do Node que é dono do socket de escuta e de toda
conexão em andamento. Quando o orquestrador para seu container — um `docker
stop`, uma rotação de pod do Kubernetes, um restart do systemd — ele envia
`SIGTERM`. Se você ignorar, o handler padrão do Node termina o processo no meio do
voo: requisições em andamento são descartadas e qualquer pool que você abriu nunca
fecha. O próximo deploy trunca trabalho ao vivo.

A sequência correta é sempre a mesma: capturar o sinal uma vez, parar de aceitar
novas conexões, deixar as requisições em andamento terminarem, rodar seu teardown,
e forçar a saída se uma conexão travar. Acertar a ordem do dreno e a válvula de
escape é trabalhoso e idêntico em toda app, então Kata cuida disso (ADR-0014).

## `gracefulShutdown`

`gracefulShutdown` vive no subpath **`kata/node`** — o único ponto de entrada que
toca em `node:process` — para que importar o core neutro em relação ao runtime
(`kata`) de um build edge ou Workers nunca puxe o Node junto.

```ts
import { gracefulShutdown } from 'kata/node'
import type { ServerType, GracefulShutdownOptions } from 'kata/node'

function gracefulShutdown(server: ServerType, options: GracefulShutdownOptions): void

type GracefulShutdownOptions = {
  onClose: () => void | Promise<void>
  signals?: readonly NodeJS.Signals[] // default ['SIGTERM', 'SIGINT']
  timeoutMs?: number                  // default 10_000
}
```

Ele recebe o **server**, não a app. A app é o request handler; o server é o que é
dono do socket e precisa de `close()` para drenar. `ServerType` é o handle que o
`serve()` retorna — um `Server` `node:http`/`http2` — re-derivado de `@types/node`
para que `kata/node` precise apenas de `@types/node` e nunca empacote o adaptador.

```ts
// src/main.ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'kata/node'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })
const port = Number(process.env['PORT'] ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})

gracefulShutdown(server, {
  onClose: async () => {
    // Teardown sob responsabilidade da app, na ordem que a app escolher. Recursos
    // são alcançados pelo registry ou por referências capturadas em closure.
    await k.registry.db.__value.close()
  },
  // signals: ['SIGTERM', 'SIGINT'], // default
  // timeoutMs: 10_000,              // default
})
```

## O que ele faz em um sinal

No **primeiro** sinal capturado, `gracefulShutdown` roda, nesta ordem:

1. **Protege contra reentrância.** Um segundo `SIGTERM`/`SIGINT` durante o
   desligamento é ignorado — a rotina é idempotente e segura para sinal duplicado.
2. **Arma um timer de force-exit.** `setTimeout(() => process.exit(1), timeoutMs)`,
   com `.unref()` para que o timer nunca mantenha o event loop vivo por conta própria.
3. **Para de aceitar novas conexões.** `server.close()` — o Node fecha o listener e
   os sockets keep-alive ociosos; **as requisições em andamento rodam até o fim**.
4. **Aguarda o dreno das em andamento** — a conclusão do `server.close(callback)`,
   que dispara assim que toda conexão aberta termina.
5. **Roda `await onClose()`** — estritamente *depois* do dreno, para que nenhum
   handler ao vivo perca seu pool ou transação no meio de uma query.
6. **Sai com `0`** ao concluir limpo dentro do orçamento.

Se os passos 4–5 excederem `timeoutMs`, o timer dispara primeiro e o processo
força a saída com código **diferente de zero** — trabalho em andamento foi
abandonado, um desfecho distinto e visível para o orquestrador, não uma parada
limpa. Se o dreno ou o `onClose` lançar, o processo também sai com código diferente
de zero.

O listener do sinal permanece registrado durante todo o desligamento, então um
segundo sinal é capturado e engolido pelo guard de reentrância em vez de atingir o
handler de término padrão do Node.

## `onClose`: seu teardown, sua ordem

Kata não é dono de nenhum registry de dispose. Não há hook `dispose` no
`singleton()` e nada percorre o registry por você. `onClose` é o único lugar onde
você sequencia o teardown, e a ordem é sua — teardown é o inverso da construção e
específico do domínio, algo que só a app conhece:

```ts
gracefulShutdown(server, {
  onClose: async () => {
    await metrics.flush()   // primeiro dá flush nas métricas bufferizadas
    await queue.stop()      // depois para o consumer da fila
    await k.registry.db.__value.close() // por último, fecha o pool
  },
})
```

A política de falha parcial também é sua: envolva um passo em `try/catch` dentro do
`onClose` se quiser continuar após um recurso que falha ao fechar. Qualquer coisa
que o `onClose` esquecer de fechar simplesmente vaza no desligamento — o custo de
não ser dono de um registry.

::: warning Defina `timeoutMs` abaixo do período de graça do orquestrador
`timeoutMs` (default 10 s) é um deadline *soft* que ainda permite uma saída limpa.
O do orquestrador é o *hard*. O `terminationGracePeriodSeconds` do Kubernetes tem
default de 30 s, após o qual ele envia um `SIGKILL` incapturável. Mantenha
`timeoutMs` dentro dessa janela para vencer o `SIGKILL` e desligar nos seus próprios
termos.
:::

## Sinais

O default é `['SIGTERM', 'SIGINT']`:

- **`SIGTERM`** — o sinal de parada graciosa do orquestrador (`docker stop`,
  término de pod do Kubernetes, systemd).
- **`SIGINT`** — Ctrl-C em um terminal de dev, para que o desligamento local
  também drene.

`SIGKILL` e `SIGSTOP` são incapturáveis por definição. `SIGHUP` (a semântica de
reload varia conforme o deployment) é deixado para você de propósito. Sobrescreva o
conjunto com `signals` se precisar de uma captura diferente.

::: info Habilite a partir do `main.ts`
`createApp` não instala nenhum signal handler. Registrar listeners de `process.on`
como efeito colateral de construir uma app vazaria listeners duplicados entre
múltiplas apps e execuções de teste, acoplaria o core neutro em relação ao runtime
ao `node:process`, e estaria errado para hosts serverless ou embarcados que nunca
são donos do processo. `main.ts` — o único lugar onde o layout deixa você falar com
o `process` — chama `gracefulShutdown` explicitamente.
:::

## Como ele se relaciona com `@hono/node-server`

`@hono/node-server` é o adaptador Node: o `serve()` dele faz o bind do socket e
roda `app.fetch` para cada requisição. Kata não adiciona nada a isso — não envolve
nem re-exporta o `serve()`. `gracefulShutdown` opera sobre o handle `Server` que o
`serve()` retorna, chamando o `close(callback)` padrão dele. Os dois se compõem: o
`serve()` abre o socket, o `gracefulShutdown` o drena e o fecha.

## Outros runtimes

`kata/node` é exclusivo de Node e é o único adaptador de ciclo de vida da v0.3.
Edge e Workers não têm processo de longa duração para sinalizar; Bun e Deno expõem
sinais mas divergem na semântica de fechamento de server. Ciclo de vida
cross-runtime fica adiado para o milestone v0.4. Nesses runtimes você serve a app da
mesma forma — entrega `app.fetch` ao adaptador próprio do runtime — mas não usa
`gracefulShutdown`.

## Veja também

- [/pt/reference/create-app](/pt/reference/create-app) — a app que você serve e sua config.
- [/pt/guide/context-di](/pt/guide/context-di) — singletons eager e o registry que
  você alcança no `onClose`.
- [/pt/cookbook/database](/pt/cookbook/database) — fechando um pool de conexões no
  desligamento, de ponta a ponta.
- [ADR-0014](/adr/0014-lifecycle-shutdown) — por que o teardown é um callback, não um
  registry de auto-dispose.
