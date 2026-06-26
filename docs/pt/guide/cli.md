---
title: CLI de bootstrap
description: kata init faz o scaffold de um app Kata completo e executável — o layout canônico, dois módulos de exemplo e o harness de agentes — em um comando. kata new adiciona módulos; kata verify roda as regras de lint.
---

# CLI de bootstrap

O Kata distribui um binário, `kata`, com três comandos:

- **`kata init [dir]`** — faz o scaffold de um app completo e executável. Esta página o cobre.
- **`kata new <domain>`** — gera o esqueleto de um módulo em `src/modules/`.
- **`kata verify [path]`** — roda as regras de lint do Kata; no modo `--json` emite
  a saída de hook que um agente consome. Sua superfície completa — o conjunto de
  regras, `--json` e `--watch` — vive em [o harness](/pt/guide/harness); a seção
  [`kata verify`](#kata-verify) abaixo é uma referência rápida.

`kata init` leva você de zero a um servidor rodando em um comando. Ele escreve o
[layout de projeto](/pt/guide/project-layout) canônico — `src/app.ts`,
`src/context.ts`, uma pasta `middlewares/` e dois módulos prontos — em cima do
**harness de agentes** (as configs de hook do Claude / Codex / agents e o par de
instruções `AGENTS.md` / `CLAUDE.md`) mais o toolchain de lint/format. Ele não
instala nada: escreve um conjunto fixo de arquivos, de forma idempotente, e
reporta o que fez.

## `kata init`

```bash
kata init my-app      # faz o scaffold em ./my-app
kata init             # …ou faz o scaffold no diretório atual
```

O `[dir]` opcional é criado se não existir e resolvido relativo a `--cwd`
(padrão: o diretório atual). O `package.json` gerado recebe esse nome.

```
kata init → /path/to/my-app
  create  .claude/settings.json
  create  .codex/hooks.json
  create  .agents/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
  create  lefthook.yml
  create  biome.json
  create  .oxlintrc.json
  create  src/context.ts
  create  src/app.ts
  create  src/main.ts
  create  src/middlewares/request-logger.ts
  create  src/modules/health/health.schema.ts
  create  src/modules/health/health.service.ts
  create  src/modules/health/health.route.ts
  create  src/modules/health/health.test.ts
  create  src/modules/health/health.hurl
  create  src/modules/greetings/greetings.schema.ts
  create  src/modules/greetings/greetings.service.ts
  create  src/modules/greetings/greetings.route.ts
  create  src/modules/greetings/greetings.test.ts
  create  src/modules/greetings/greetings.hurl
  create  package.json
  create  tsconfig.json
  create  .gitignore
  create  README.md

Next steps:
  cd my-app
  pnpm install
  pnpm dev          # → http://localhost:3000/health
  kata verify       # fast deterministic checks
  pnpm test         # unit tests
```

### Os arquivos do harness

Eles transformam uma sessão de agente em uma sessão guardada: ela roda
`kata verify --json` a cada escrita de arquivo e `pnpm test` antes de poder
terminar. A paridade entre os harnesses é garantida por construção — veja
[o harness](/pt/guide/harness).

| Arquivo | O que é |
|---|---|
| `.claude/settings.json` | Hooks do Claude Code (PreToolUse / PostToolUse / Stop) mais uma lista `permissions.deny` que bane adulteração de config e bypass de verificação no commit/push. |
| `.codex/hooks.json` | O espelho Codex da mesma cadeia de hooks. O Codex não tem slot `permissions`, então os mesmos bans rodam via `kata verify` no PreToolUse. |
| `.agents/hooks.json` | Um **espelho neutro de fornecedor** da mesma cadeia Pre/Post/Stop, para qualquer harness que leia a convenção emergente `.agents/`. Os mesmos comandos dos dois acima. |
| `AGENTS.md` | O arquivo de instruções canônico, agnóstico de agente. O Codex o carrega nativamente. |
| `CLAUDE.md` | Um entrypoint fino do Claude Code que importa `AGENTS.md` via `@AGENTS.md` e adiciona notas específicas do Claude. |
| `lefthook.yml` | O pre-commit local do git: `kata verify`, formatação Biome, oxlint e typecheck a cada commit. |

### Os arquivos do app

O menor app *completo* que sobe, passa no typecheck, nos testes e no
`kata verify` — o [layout](/pt/guide/project-layout) canônico, não um tutorial.

| Arquivo | O que é |
|---|---|
| `src/context.ts` | `defineContext({})` mais um re-export de `createApp` / `defineRoute` / `defineMiddleware`. A superfície de DI tipada, começando vazia. |
| `src/app.ts` | `createApp({ modules, middlewares })` — a aplicação, composta dos módulos e da cadeia de middleware global. |
| `src/main.ts` | O entrypoint de runtime: `serve` o app com `@hono/node-server`. |
| `src/middlewares/request-logger.ts` | Um middleware global de exemplo (`provides: []`) que loga cada requisição. |
| `src/modules/health/` | `GET /health` → `200 {"status":"ok"}` — a menor rota, com o conjunto completo de cinco arquivos do módulo (route / service / schema / test / hurl). |
| `src/modules/greetings/` | `POST /greetings` (body validado) + `GET /greetings/:id` (params validados, `404` se não achar) — o padrão criar/ler. |
| `biome.json` / `.oxlintrc.json` | As configs de formatter e linter que o pre-commit roda. Escritas **só se ausentes**. |
| `package.json` / `tsconfig.json` | Scripts, deps fixadas e opções estritas do compilador. Escritos **só se ausentes**. |
| `.gitignore` / `README.md` | Ignores padrão e um quickstart por app. Escritos **só se ausentes**. |

### Opções

```
-C, --cwd <dir>     Diretório base para resolver [dir] (padrão: cwd)
    --minimal       Escreve só as configs do harness — sem app (para projetos existentes)
-f, --force         Sobrescreve arquivos-fonte existentes (nunca os manifests/configs)
-h, --help          Mostra esta ajuda
```

`--cwd` também aceita a forma `--cwd=<dir>`.

### De zero a um servidor rodando

```bash
kata init my-app
cd my-app
pnpm install        # o único passo manual — um scaffolder não pode enviar node_modules
pnpm dev            # tsx watch src/main.ts → http://localhost:3000
```

```bash
curl localhost:3000/health
# {"status":"ok"}

curl -X POST localhost:3000/greetings -H 'content-type: application/json' -d '{"name":"Ada"}'
# {"id":"…","message":"Hello, Ada!"}
```

O `package.json` gerado conecta os scripts do dia a dia: `pnpm dev` (watch),
`pnpm start`, `pnpm test` (Vitest), `pnpm typecheck`, `kata verify` e `pnpm hurl`
(a suíte de E2E de API `.hurl` — precisa do [Hurl](https://hurl.dev) instalado e
do servidor rodando).

::: warning Pré-lançamento & nome do pacote
O framework é publicado no npm como **`katajs`** (o nome `kata` já estava em uso),
então o `package.json` gerado depende de `katajs`. A CLI/bin continua `kata` — os
scripts e hooks chamam `kata verify`. Ele ainda não foi publicado, então
`pnpm install` ainda não consegue resolver o `package.json` gerado; enquanto isso,
rode o exemplo do repositório (veja o [Início rápido](/pt/guide/quickstart)).
:::

### `kata init --minimal`

Para adicionar o harness a um projeto **existente** sem espalhar um app nele,
passe `--minimal`: ele escreve só os seis arquivos do harness (`.claude` /
`.codex` / `.agents` / `AGENTS.md` / `CLAUDE.md` / `lefthook.yml`) e nada mais.

```bash
kata init --minimal
```

```
kata init → /path/to/project
  create  .claude/settings.json
  create  .codex/hooks.json
  create  .agents/hooks.json
  create  AGENTS.md
  create  CLAUDE.md
  create  lefthook.yml

Harness configs written. Commit them, then start coding —
the PreToolUse/Stop hooks run `kata verify` and `pnpm test` for you.
```

### Idempotência

`kata init` é seguro de rodar de novo. Um arquivo existente é deixado intocado e
reportado como `skip`; só os arquivos ausentes são escritos. Passe `--force` para
sobrescrever os arquivos-**fonte** — os manifests e configs nunca são tocados
(veja abaixo).

```
kata init → /path/to/my-app
    skip  .claude/settings.json
    skip  src/app.ts
    …
Some files already existed and were left untouched.
Re-run with --force to overwrite source files (manifests are never touched).
```

::: tip
Rode `kata init --force` de novo depois de atualizar o Kata para puxar os
arquivos atualizados de harness e fonte. Seu `package.json`, `tsconfig.json` e
configs de lint permanecem.
:::

### Manifests e configs nunca são sobrescritos

Os arquivos `src/` respeitam `--force`. Os manifests e configs de lint/format
não: um `package.json`, `tsconfig.json`, `biome.json`, `.oxlintrc.json`,
`.gitignore` ou `README.md` existente é **sempre** deixado intocado, mesmo com
`--force`. Rodar `kata init` dentro de um projeto que já tem esses arquivos
preenche só os que faltam e reporta o resto como `skip` — ele nunca reescreve sua
lista de dependências, config do compilador ou regras de lint.

### O que os módulos de exemplo contêm

`src/modules/greetings/greetings.schema.ts` — todos os schemas Zod do domínio
vivem aqui, nunca inline na rota ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).

```ts
import { z } from 'zod'

export const CreateGreetingBodySchema = z.object({ name: z.string().min(1) })
export const GreetingParamsSchema = z.object({ id: z.string() })
export const GreetingSchema = z.object({ id: z.string(), message: z.string() })

export type CreateGreetingBody = z.infer<typeof CreateGreetingBodySchema>
export type Greeting = z.infer<typeof GreetingSchema>
```

`src/modules/greetings/greetings.route.ts` — um POST e um GET, cada um declarando
`input` e `output` e importando seus schemas por nome.

```ts
import { defineRoute } from '../../context'

import { CreateGreetingBodySchema, GreetingParamsSchema, GreetingSchema } from './greetings.schema'
import { createGreeting, getGreeting } from './greetings.service'

export const createGreetingRoute = defineRoute({
  method: 'POST',
  path: '/greetings',
  input: { body: CreateGreetingBodySchema },
  output: GreetingSchema,
  handler: (c) => createGreeting(c.input.body),
})

export const getGreetingRoute = defineRoute({
  method: 'GET',
  path: '/greetings/:id',
  input: { params: GreetingParamsSchema },
  output: GreetingSchema,
  handler: (c) => {
    const greeting = getGreeting(c.input.params.id)
    if (!greeting) return c.error('not_found', 'Greeting not found', { status: 404 })
    return greeting
  },
})
```

`src/app.ts` — a aplicação: módulos como imports de namespace, mais a cadeia de
middleware global ([ADR-0012](/adr/0012-app-level-middleware)).

```ts
import { createApp } from './context'
import { requestLogger } from './middlewares/request-logger'
import * as greetings from './modules/greetings/greetings.route'
import * as health from './modules/health/health.route'

export const app = createApp({
  modules: [health, greetings],
  middlewares: [requestLogger],
})
```

Faça o app crescer adicionando módulos em `src/modules/<domain>/` e listando-os
em `createApp({ modules: [...] })`. O `kata new` da próxima seção faz o boilerplate.

## `kata new`

Adiciona um módulo a um app existente:

```bash
kata new orders
```

```
kata new orders → /path/to/project
  create  src/modules/orders/orders.route.ts
  create  src/modules/orders/orders.service.ts
  create  src/modules/orders/orders.schema.ts
  create  src/modules/orders/orders.test.ts
  create  src/modules/orders/orders.hurl
```

Ele escreve o esqueleto de cinco arquivos do módulo — route / service / schema /
test / hurl — em `src/modules/<domain>/`. Registre-o no `src/app.ts` importando o
módulo de rota e adicionando-o a `createApp({ modules: [...] })`. Como o
`kata init`, ele pula arquivos existentes a menos que você passe `--force`, e
respeita `--cwd`.

## `kata verify`

Roda as regras de lint determinísticas do Kata sobre um projeto:

```bash
kata verify [path]      # caminho padrão: o diretório atual
```

Ele lê o projeto, checa as regras ancoradas em ADR-0003 / 0004 / 0005 e imprime
um relatório legível. Duas flags moldam como ele roda:

- `kata verify --json` — emite o JSON de hook `PostToolUse` do Claude Code em vez
  do relatório de terminal. É exatamente o que os hooks gerados chamam a cada
  escrita de arquivo.
- `kata verify --watch` — fica rodando e re-checa a cada mudança, para um loop
  local apertado.

Rode `kata verify --help` para a lista completa de flags. O conjunto de regras, o
contrato JSON e como os hooks o conectam ao Claude Code e ao Codex estão
documentados em [o harness](/pt/guide/harness).

## Sem comando, ou um desconhecido

Rodar `kata` sem comando, ou com um comando desconhecido, imprime a ajuda de uso e
sai com código diferente de zero:

```bash
kata
# kata: missing command (try `kata init`)
```

## Veja também

- [Layout do projeto](/pt/guide/project-layout) — a estrutura de pastas travada que o `kata init` escreve.
- [O harness](/pt/guide/harness) — o que as configs de hook geradas impõem.
- [Início rápido](/pt/guide/quickstart) — construa e suba uma API `/users` completa na mão.
- [ADR-0015](/adr/0015-bootstrap-cli) — a decisão original de bootstrap (o app
  mínimo atrás de `--with-example`), superada pelo scaffold de app completo por padrão.
