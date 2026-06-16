---
title: CLI de bootstrap
description: kata init faz o scaffold de um projeto já conectado ao harness — hooks do Claude/Codex, instruções para agentes e um app GET /health executável opcional. Idempotente por padrão.
---

# CLI de bootstrap

Kata distribui um único binário, `kata`. Ele tem exatamente um comando: `init`.
Rode-o dentro de um projeto para escrever o harness — as configs de hook do
Claude Code e do Codex mais o par de instruções `AGENTS.md` / `CLAUDE.md`.
Adicione `--with-example` e ele também faz o scaffold de um app `GET /health`
executável que você pode subir com mais um passo.

A CLI não instala nada, não gerencia versões e não gera código por rota. Ela
escreve um conjunto fixo de arquivos, de forma idempotente, e relata o que fez.

## `kata init`

```bash
kata init
```

Escreve os quatro arquivos do harness no diretório atual:

```
kata init → /path/to/project
  create  .claude/settings.json
  create  .codex/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
```

| Arquivo | O que é |
|---|---|
| `.claude/settings.json` | Hooks do Claude Code (PreToolUse / PostToolUse / Stop) mais uma lista `permissions.deny` que proíbe adulteração de configs e bypasses de verificação em commit/push. |
| `.codex/hooks.json` | O espelho no Codex da mesma cadeia de hooks. O Codex não tem um slot `permissions`, então as mesmas proibições são impostas via `kata verify` no PreToolUse. |
| `AGENTS.md` | O arquivo de instruções canônico e agnóstico a agente. O Codex o carrega nativamente. |
| `CLAUDE.md` | Um ponto de entrada enxuto do Claude Code que importa o `AGENTS.md` via `@AGENTS.md` e adiciona notas de harness específicas do Claude. |

Estes quatro arquivos são o harness. Eles fazem um agente rodar `kata verify --json`
a cada escrita de arquivo e `pnpm test` antes que ele possa encerrar uma sessão.
Veja [o harness](/pt/guide/harness) para entender o que cada hook faz e por que a
paridade entre Claude e Codex é imposta por construção.

### Opções

```
-C, --cwd <dir>     Project root to scaffold into (default: current directory)
-f, --force         Overwrite existing files instead of skipping them
    --with-example  Also scaffold a runnable example app (GET /health)
-h, --help          Show this help
```

`--cwd` também aceita a forma `--cwd=<dir>`.

### Idempotência

`kata init` é seguro de rodar de novo. Um arquivo existente é deixado intocado e
relatado como `skip`; só os arquivos faltantes são escritos. Passe `--force` para
sobrescrever os quatro arquivos do harness.

```
kata init → /path/to/project
    skip  .claude/settings.json
    skip  .codex/hooks.json
    skip  AGENTS.md
    skip  CLAUDE.md

Some files already existed and were left untouched.
Re-run with --force to overwrite them.
```

::: tip
Rode `kata init` de novo depois de atualizar o Kata para puxar as configs de hook
atualizadas com `--force`. Como os arquivos do harness são a única coisa que ele
sobrescreve, seu código-fonte fica intocado.
:::

## `kata init --with-example`

```bash
kata init --with-example
```

Escreve os quatro arquivos do harness **e** um app executável mínimo em cima
deles:

```
kata init → /path/to/project
  create  .claude/settings.json
  create  .codex/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
  create  src/context.ts
  create  src/main.ts
  create  src/modules/health/health.route.ts
  create  src/modules/health/health.schema.ts
  create  package.json
  create  tsconfig.json
```

O exemplo é o menor app que sobe e passa no `kata verify`: uma única rota
`GET /health` que declara `input` e `output`, mantém seu schema em um
`.schema.ts` separado e não usa DI.

| Arquivo | O que é |
|---|---|
| `src/context.ts` | `defineContext({})` mais um re-export de `createApp` / `defineRoute`. A superfície tipada de DI, começando vazia. |
| `src/main.ts` | `createApp({ modules: [health] })` conectado ao `serve` de `@hono/node-server`. |
| `src/modules/health/health.route.ts` | `defineRoute` para `GET /health` → `200 {"status":"ok"}`. |
| `src/modules/health/health.schema.ts` | `HealthSchema` — o DTO de resposta em Zod. |
| `package.json` | Scripts e deps fixadas. Escrito **só se ausente**. |
| `tsconfig.json` | Opções de compilador estritas e autocontidas. Escrito **só se ausente**. |

### Do zero ao `GET /health`

```bash
mkdir my-app && cd my-app
kata init --with-example
pnpm install
pnpm start          # tsx src/main.ts → http://localhost:3000
```

```bash
curl localhost:3000/health
# {"status":"ok"}
```

Instalar as dependências é o único passo manual — um scaffolder não pode
distribuir o `node_modules`. Depois disso, `pnpm start` roda `src/main.ts` e
`pnpm dev` roda em modo watch.

::: warning Pré-lançamento
O Kata ainda não foi publicado no npm, então o `pnpm install` ainda não consegue
resolver o `package.json` gerado. Até lá, rode o exemplo trabalhado a partir do
repositório — veja [Início rápido](/pt/guide/quickstart).
:::

### O que os arquivos gerados contêm

`src/context.ts` — a superfície tipada de DI. Ela começa vazia; você registra
slots `singleton(...)` / `scoped<T>()` aqui conforme o app cresce.

```ts
import { defineContext } from 'kata'

export const k = defineContext({})

export const { defineRoute, createApp } = k
```

`src/modules/health/health.schema.ts` — o DTO de resposta. Schemas ficam no seu
próprio `.schema.ts`, nunca inline na rota.

```ts
import { z } from 'zod'

export const HealthSchema = z.object({
  status: z.literal('ok'),
})

export type Health = z.infer<typeof HealthSchema>
```

`src/modules/health/health.route.ts` — a menor rota válida. Ela declara tanto
`input` quanto `output`.

```ts
import { defineRoute } from '../../context'

import { HealthSchema } from './health.schema'

export const healthRoute = defineRoute({
  method: 'GET',
  path: '/health',
  input: {},
  output: HealthSchema,
  handler: () => ({ status: 'ok' as const }),
})
```

`src/main.ts` — ponto de entrada. `createApp` recebe os módulos de rota como
imports de namespace; `serve` os sobe no Node.

```ts
import { serve } from '@hono/node-server'

import { createApp } from './context'
import * as health from './modules/health/health.route'

const app = createApp({ modules: [health] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log('kata: listening on http://localhost:' + info.port)
})
```

Faça o app crescer adicionando módulos em `src/modules/<domain>/` e listando-os
em `createApp({ modules: [...] })`. Veja [Rotas e schemas](/pt/guide/routes-schemas)
para a superfície completa de rotas e [Layout do projeto](/pt/guide/project-layout)
para a estrutura de pastas travada.

### `package.json` / `tsconfig.json` nunca são sobrescritos

Os quatro arquivos de código-fonte honram o `--force` como os arquivos do
harness. Os dois manifestos não: um `package.json` ou `tsconfig.json` existente é
**sempre** deixado intocado, mesmo com `--force`. Rodar `--with-example` dentro de
um projeto que já tem um manifesto preenche só os arquivos de código faltantes e
relata os manifestos como `skip` — ele nunca reescreve sua lista de dependências
ou config de compilador.

::: warning
`kata init --with-example` espalha arquivos `src/` no diretório atual. Rode-o em
um diretório novo ou já no formato Kata; o skip-on-exists protege os arquivos
existentes, mas os novos ainda aparecem onde você o roda.
:::

## Outros comandos

Não há nenhum. `kata` tem um único comando, `init`. Rodar `kata` sem comando, ou
com um comando desconhecido, imprime a ajuda de uso e sai com código diferente de
zero:

```bash
kata
# kata: missing command (try `kata init`)
```

Um gerador de módulo por domínio (`kata new <domain>`) está reservado, mas ainda
não foi implementado; veja [ADR-0015](/adr/0015-bootstrap-cli) para a decisão de
estender o `kata init` com uma flag em vez de adicionar um segundo comando de
scaffolding.

## Veja também

- [O harness](/pt/guide/harness) — o que as configs de hook geradas impõem.
- [Início rápido](/pt/guide/quickstart) — construa e suba uma API `/users` completa à mão.
- [ADR-0015](/adr/0015-bootstrap-cli) — por que o bootstrap é uma flag no `init`.
