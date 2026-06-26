---
title: Referência da API
description: Cada export público de kata, kata/jwt e kata/node, além do bin kata e das dependências peer.
---

# Referência da API

Kata distribui um único pacote, `katajs`, com três caminhos de import e um binário.
Nada é re-exportado de Hono — a superfície pública é exatamente o que as tabelas
abaixo listam, derivada dos próprios entry points do pacote.

| Import | Propósito |
|---|---|
| `katajs` | Núcleo: a factory de contexto, os construtores de slot, o error envelope, os middlewares embutidos e todos os tipos públicos. |
| `katajs/jwt` | Primitivas JWT stateless mais o middleware `jwtAuth` e os guards de autorização. |
| `katajs/node` | `gracefulShutdown` exclusivo de Node, para drenar um servidor em `SIGTERM` / `SIGINT`. |
| `kata` (bin) | A CLI: `kata init` faz o scaffold de um app completo, `kata new` adiciona um módulo, `kata verify` roda as regras de lint. |

```ts
import { defineContext, scoped, singleton } from 'katajs'
import { jwtAuth, requireRole, signJwt } from 'katajs/jwt'
import { gracefulShutdown } from 'katajs/node'
```

A divisão é deliberada: `katajs` é neutro em relação ao runtime e roda onde quer que
Hono rode (Node, Bun, Deno, edge), `katajs/jwt` é o único módulo que toca `hono/jwt`,
e `katajs/node` é o único módulo que toca `node:process` — assim, um build edge que
importa `katajs` nunca puxa internals do Node.

## Dependências peer

Kata declara duas dependências peer. Instale-as junto com `katajs`; ele não empacota
nenhuma das duas.

```json
{
  "peerDependencies": {
    "hono": "^4",
    "zod": "^3"
  }
}
```

| Peer | Faixa | Usada para |
|---|---|---|
| `hono` | `^4` | O router, o contexto, os adaptadores de runtime e o cliente RPC tipado (`hc`). |
| `zod` | `^3` | Cada schema de `input` / `output` e os schemas de claims em `katajs/jwt`. |

## `katajs` — núcleo

Valores:

| Export | Tipo | Propósito |
|---|---|---|
| `defineContext` | função | O registry de DI único. Recebe um registry de slots e retorna `{ registry, defineRoute, defineMiddleware, createApp }`, todos ligados a ele. |
| `singleton` | função | `singleton(value)` — declara um slot com tempo de vida do processo, guardando `value`. |
| `scoped` | função | `scoped<T>()` — declara um slot por request do tipo `T`, preenchido por um middleware. |
| `cors` | função | Middleware de CORS embutido. |
| `secureHeaders` | função | Middleware de headers de segurança embutido. |
| `bodyLimit` | função | Middleware embutido de limite de tamanho do corpo da request. |
| `DEFAULT_MAX_BODY_SIZE` | const | O teto de bytes padrão que `bodyLimit` aplica quando nenhum `maxBytes` é informado. |
| `buildErrorBody` | função | Constrói o error envelope unificado (ADR-0008) como um objeto plano — `{ error, message, issues? }`. |
| `formatZodIssues` | função | Converte um `ZodError` no formato `FieldIssue[]` usado nos error envelopes. |
| `ErrorBodySchema` | schema Zod | Schema Zod para o error envelope; declare-o atrás de um status 4xx/5xx em um mapa de `output`. |
| `FieldIssueSchema` | schema Zod | Schema Zod para um issue de campo estruturado; compõe `ErrorBodySchema`. |
| `REQUEST_ID_HEADER` | const | O header (`x-request-id`) do qual Kata lê um id de correlação de entrada e ecoa de volta. |

Tipos:

| Export | Propósito |
|---|---|
| `AppConfig` | O objeto que `createApp` aceita (`modules`, `middlewares?`, `requestLogging?`, `outputValidation?`). |
| `Route` | Um valor de route produzido por `defineRoute`. |
| `Module` | Um record de routes nomeadas — o que um `import * as` de um arquivo `*.route.ts` produz. |
| `Middleware` | Um valor de middleware produzido por `defineMiddleware`. |
| `MiddlewareContext` | O `c` passado a um handler de middleware (`get`, `set`, `header`, `json`, `error`, `raw`, `requestId`). |
| `RouteContext` | O `c` passado a um handler de route (`get`, `input`, `json`, `error`, `raw`, `requestId`). |
| `HttpMethod` | Os métodos suportados: `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'`. |
| `InputSchemas` | O formato de `input`: `{ params?, query?, body?, headers? }` de schemas Zod. |
| `InferInput` | O `z.infer` de um `InputSchemas`, como exposto em `c.input`. |
| `OutputSpec` | O `output` de uma route: um único schema Zod ou um `OutputMap`. |
| `OutputMap` | Um mapa status-code → schema Zod, ex.: `{ 200: X, 404: Y }`. |
| `SuccessOutput` | O tipo do corpo 200 que um handler pode retornar como valor plano. |
| `RouteHandlerReturn` | O que um handler pode retornar: `SuccessOutput` ou um `Response`. |
| `Registry` | O tipo de registry que `defineContext` aceita — um record de `Slot`s. |
| `Slot` | Um `Singleton<unknown>` ou `Scoped<unknown>`. |
| `Singleton` | Um tipo de slot singleton. |
| `Scoped` | Um tipo de slot scoped. |
| `SingletonKeys` | As chaves singleton de um registry. |
| `ScopedKeys` | As chaves scoped de um registry — as únicas chaves que um middleware pode `provides`/`set`. |
| `ResolvedValue` | O tipo de valor para o qual um slot resolve via `c.get`. |
| `Logger` | O formato de logger estruturado que um singleton `logger` pode satisfazer para logging por request. |
| `OutputValidationMode` | `'strict' \| 'log' \| 'off'` — como uma divergência de output-schema é tratada (ADR-0009). |
| `ErrorBody` | O tipo do objeto error-envelope: `{ error, message, issues? }`. |
| `ErrorExtra` | Os extras opcionais para `c.error` / `buildErrorBody`: `{ status?, issues? }`. |
| `FieldIssue` | Um erro de campo estruturado: `{ path, message, code, expected?, received? }`. |
| `FieldIssues` | `Record<string, FieldIssue[]>`, chaveado pela origem do input. |
| `KataApp` | O tipo paramétrico do app Hono que `createApp` retorna — `export type AppType = KataApp<typeof modules>` alimenta o cliente RPC. |
| `RpcModule` | A projeção relevante para o wire de um módulo, usada pela ponte de tipos RPC. |
| `ModulesToHonoSchema` | O `Schema` RPC do Hono derivado de uma tupla de módulos. |

Tipos de opções dos middlewares embutidos — `CorsOptions`, `SecureHeadersOptions` e
`BodyLimitOptions` — também são exportados. Veja [Middleware](/pt/reference/middleware)
para os campos deles.

## `katajs/jwt` — auth

Valores:

| Export | Tipo | Propósito |
|---|---|---|
| `signJwt` | função | `signJwt(claims, options)` — assina um objeto de claims em um JWT compacto. Carimba `iat`; `options` define os claims registrados (`exp`, `nbf`, `iss`, `aud`, `sub`). |
| `verifyJwt` | função | `verifyJwt(token, options)` — verifica a assinatura + os claims de tempo, depois faz o parse do payload através de `options.claims`. Retorna um `Result`, nunca lança. |
| `jwtAuth` | função | Constrói um *handler* de middleware que lê `Authorization: Bearer <token>`, o verifica e escreve os claims (ou um usuário vindo de `resolve`) em um slot scoped. Envolva com `defineMiddleware({ provides: [...] })`. |
| `guard` | função | Constrói um *handler* de guard de autorização que lê um slot já provido e rejeita com um envelope 403 quando `authorize` retorna false. |
| `requireRole` | função | Açúcar sobre `guard`: permite apenas quando o `role` do valor do slot é (um d)os role(s) informado(s). |
| `requireClaim` | função | Açúcar sobre `guard`: permite apenas quando o claim do valor do slot em `key` é igual a `expected` (ou passa no predicado informado). |

Tipos:

| Export | Propósito |
|---|---|
| `JwtAlgorithm` | Os algoritmos de assinatura suportados (`HS*`, `RS*`, `PS*`, `ES*`, `EdDSA`). |
| `SignOptions` | Opções para `signJwt`: `secret`, `alg?`, `expiresInSeconds?`, `notBeforeSeconds?`, `issuer?`, `audience?`, `subject?`. |
| `VerifyOptions` | Opções para `verifyJwt`: `secret`, `claims`, `alg?`, `issuer?`, `audience?`. |
| `JwtVerifyResult` | O resultado de `verifyJwt`: `{ ok: true, claims }` ou `{ ok: false, error }`. |
| `JwtError` | Uma falha de verificação: `{ code, message, issues? }`. |
| `JwtErrorCode` | `'invalid_token' \| 'expired' \| 'claims_mismatch'`. |
| `JwtAuthOptions` | Opções para `jwtAuth`: `secret`, `claims`, `slot?`, `alg?`, `issuer?`, `audience?`, `header?`, `resolve?`. |
| `GuardOptions` | Opções para `guard`: `slot?`, `authorize`, `code?`, `message?`. |

::: tip Você é dono do fluxo de login
`katajs/jwt` te dá assinatura, verificação, o middleware de auth e os guards.
Hashing de senha, o store de usuários, a route de login e os refresh tokens continuam sendo seus.
Veja o [cookbook de Autenticação](/pt/cookbook/auth) para o padrão completo.
:::

## `katajs/node` — runtime Node

Valores:

| Export | Tipo | Propósito |
|---|---|---|
| `gracefulShutdown` | função | `gracefulShutdown(server, options)` — captura sinais de término, para de aceitar conexões, drena as requests em andamento e então executa `onClose`. |

Tipos:

| Export | Propósito |
|---|---|
| `ServerType` | O handle de servidor `node:http` / `node:http2` que o `serve()` do `@hono/node-server` retorna. |
| `GracefulShutdownOptions` | Opções para `gracefulShutdown`: `onClose`, `signals?` (padrão `['SIGTERM', 'SIGINT']`), `timeoutMs?` (padrão `10_000`). |

`gracefulShutdown` recebe o *servidor*, não o app: o app é o request handler, o
servidor é dono do socket que precisa ter `close()` chamado para drenar. Opte por
ele a partir do `main.ts` — `createApp` não instala nenhum signal handler.

## `kata` — o bin

O pacote instala um binário `kata` com três comandos: `kata init` faz o scaffold
de um projeto, `kata new <domain>` adiciona um módulo e `kata verify` roda as
regras de lint.

```bash
kata init [dir] [options]
```

| Opção | Propósito |
|---|---|
| `-C, --cwd <dir>` | Diretório base para resolver `[dir]`. Padrão é o diretório atual. |
| `--minimal` | Escreve só as configs do harness — sem app (para projetos existentes). |
| `-f, --force` | Sobrescreve arquivos-fonte existentes (nunca os manifests/configs). |
| `-h, --help` | Imprime o uso e sai. |

Por padrão, `kata init` escreve um app completo e executável: o harness
(`.claude` / `.codex` / `.agents` + `AGENTS.md` / `CLAUDE.md` / `lefthook.yml`),
o layout `src/` canônico com dois módulos de exemplo e — apenas se ausentes —
`package.json`, `tsconfig.json` e as configs de lint. Veja [A CLI](/pt/guide/cli)
para o passo a passo completo.

## Páginas de referência

- [defineContext](/pt/reference/define-context) — o registry de DI e os tipos de slot.
- [defineRoute](/pt/reference/define-route) — config de route, `input` e `output`.
- [defineMiddleware](/pt/reference/define-middleware) — `provides` e o handler.
- [createApp](/pt/reference/create-app) — `AppConfig` e o app Hono retornado.
- [Middleware](/pt/reference/middleware) — `cors`, `secureHeaders`, `bodyLimit`.
- [JWT](/pt/reference/jwt) — `signJwt`, `verifyJwt`, `jwtAuth` e os guards.
