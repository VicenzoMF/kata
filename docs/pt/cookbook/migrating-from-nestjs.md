# Receita: Migrando de NestJS para Kata

**Problema:** você conhece NestJS — controllers, providers, modules, guards, pipes,
DTOs — e quer o equivalente em Kata sem reaprender um framework do zero.

**Padrão:** todo bloco de construção do NestJS mapeia para uma função simples ou
um objeto simples em Kata. Não há classes nem decorators ([ADR-0002](/adr/0002-no-classes-no-decorators)):
um controller vira um conjunto de chamadas `defineRoute`, um provider vira um slot em
`defineContext`, um guard ou interceptor vira um `defineMiddleware`, e um
DTO de class-validator vira um schema Zod. Este guia é o lado a lado.

Todo snippet de Kata abaixo está ancorado na superfície real do framework
([`packages/kata/src/index.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/index.ts)) e no
app executável [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello). Se um snippet mostra uma API,
essa API existe hoje.

> **Antes de começar.** Kata é pré-lançamento e ainda não está no npm. O caminho
> mais rápido é clonar o repositório e copiar [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello) para
> o seu `src/` — o [quickstart do README](https://github.com/VicenzoMF/kata/blob/main/README.md#quickstart) percorre
> os mesmos seis arquivos para os quais este guia migra.

## A mudança de modelo mental

NestJS resolve seu app em tempo de execução: um container IoC lê metadados de
construtor (via `reflect-metadata`), instancia providers e conecta controllers. Kata
resolve isso em **tempo de edição**: dependências são um único objeto estático, rotas são
valores simples, e não há container, reflexão nem metadados de decorator. A tese
do Kata é que isso torna o código mecanicamente verificável — uma rota é
`defineRoute({...})` e nada mais, então um hook de lint rápido (e um humano,
e um agente) pode verificá-la pela forma ([ADR-0002](/adr/0002-no-classes-no-decorators)).

| | NestJS | Kata |
|---|---|---|
| Bloco de construção | classe + decorator | função + objeto simples |
| Injeção de dependência | container IoC em runtime | uma registry estática `defineContext` |
| Conexão | `reflect-metadata` no boot | imports + `c.get('key')` |
| Contrato por rota | `ValidationPipe` / DTOs opcionais | schemas Zod `input` / `output` obrigatórios |
| Layout de código | grafo de `@Module` | pastas `modules/<domain>/` travadas |

## Cola

| NestJS | Kata | Referência |
|---|---|---|
| classe `@Controller()` com métodos `@Get()` / `@Post()` | um `defineRoute({ method, path, handler })` por endpoint | [§ Controllers](#controllers--routes) |
| `@Body()` / `@Param()` / `@Query()` / `@Headers()` | `c.input.body` / `c.input.params` / `c.input.query` / `c.input.headers` | [§ Controllers](#controllers--routes) |
| classe DTO + `class-validator` + `ValidationPipe` | schema Zod em `<domain>.schema.ts`, declarado como o `input` da rota | [§ DTOs & pipes](#dtos-pipes--validation--zod-schemas) |
| pipe de parse/transform (`ParseIntPipe`, custom) | coerção / transform do Zod (`z.coerce.number()`, `.transform()`) | [§ DTOs & pipes](#dtos-pipes--validation--zod-schemas) |
| provider `@Injectable()` (`useClass` / `useValue` / `useFactory`) | `singleton(value)` em `defineContext` | [§ Providers](#providers--dependency-injection) |
| Injeção via construtor | `c.get('key')` (tipado; resolvido sincronamente) | [§ Providers](#providers--dependency-injection) |
| Provider com escopo de requisição (`Scope.REQUEST`) | slot `scoped<T>()` + um middleware que faz `c.set` nele | [§ Request scope](#request-scoped-providers) |
| Guard (`CanActivate`) + `@UseGuards()` | `defineMiddleware` retornando `c.error(...)` (nega) ou `next()` (permite), listado em `use:` | [§ Guards](#guards-interceptors--middleware) |
| Interceptor (`NestInterceptor`) | `defineMiddleware` envolvendo `await next()` | [§ Guards](#guards-interceptors--middleware) |
| Exception filter (`@Catch`) + `HttpException` | `c.error(code, message, { status })` + a fronteira global de erro | [§ Errors](#exception-filters--cerror) |
| `@Module({ providers, controllers, imports })` | pasta `modules/<domain>/` + `createApp({ modules: [...] })` | [§ Modules](#modules--the-folder-layout) |
| `NestFactory.create(AppModule)` + `app.listen()` | `createApp({ modules })` + `serve({ fetch: app.fetch, port })` | [§ Bootstrap](#bootstrap) |
| `app.useGlobalGuards` / `useGlobalPipes` / `useGlobalFilters` | `use:` por rota + validação sempre ativa; verdadeiramente global → `createApp({ middlewares })` ([ADR-0012](/adr/0012-app-level-middleware)), ou `app.use('*', ...)` do Hono | [§ Bootstrap](#bootstrap) |

## O arquivo de contexto compartilhado

Tudo abaixo importa de um único arquivo. Kata centraliza a injeção de dependência em
uma única chamada `defineContext({...})` ([ADR-0004](/adr/0004-di-via-scoped-slots)) —
o análogo do array `providers` do seu `AppModule` raiz, mas plano e global
em vez de por módulo. `defineContext` retorna os helpers `defineRoute`,
`defineMiddleware` e `createApp` vinculados àquela registry; re-exporte
eles para que o resto do app importe de `./context`, nunca de `katajs`
diretamente. Isso espelha [`examples/hello/src/context.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/context.ts):

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'katajs'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

type Logger = { info: (msg: string, extra?: object) => void }

const logger: Logger = {
  info: (msg, extra) => console.log(`[app] ${msg}`, extra ?? ''),
}

export const k = defineContext({
  // singletons — uma instância para o processo inteiro (≈ um provider de escopo padrão)
  db: singleton(makeDb(process.env)),
  logger: singleton(logger),
  // scoped slots — um valor por requisição, definido por um middleware (≈ Scope.REQUEST)
  currentUser: scoped<User>(),
})

// Vincula os helpers a esta registry, depois importa eles em todo o resto.
export const { defineRoute, defineMiddleware, createApp } = k

export type AppRegistry = typeof k.registry
```

## Controllers → rotas

Um controller do NestJS é uma classe cujos métodos são decorados com o verbo HTTP e
o path; parâmetros são puxados com `@Body()`, `@Param()` e companhia.

```ts
// NestJS
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  getUser(@Param('id') id: string) {
    return this.users.findOne(id)
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto)
  }
}
```

Em Kata não há classe de controller. Cada endpoint é seu próprio valor
`defineRoute`, exportado por nome a partir de `<domain>.route.ts`. O verbo e o path são campos;
os inputs chegam pré-validados em `c.input`, tipados a partir dos schemas `input` da rota.
Isso espelha [`examples/hello/src/modules/users/users.route.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.route.ts):

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'

import { CreateUserBodySchema, UserIdParamSchema, UserSchema } from './users.schema'
import { createUser, findUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id', // sintaxe de path do Hono — `:id`, não `{id}`
  input: { params: UserIdParamSchema },
  output: UserSchema,
  handler: async (c) => {
    const user = await findUser(c.get('db'), c.input.params.id)
    if (!user) return c.error('not_found', 'No user with that id', { status: 404 })
    return user // um valor simples é validado contra `output`, depois enviado como 200
  },
})

export const createUserRoute = defineRoute({
  method: 'POST',
  path: '/users',
  input: { body: CreateUserBodySchema },
  output: UserSchema,
  handler: async (c) => createUser(c.get('db'), c.input.body),
})
```

Mapeando os decorators de parâmetro:

| NestJS | Kata | Requer |
|---|---|---|
| `@Param('id') id: string` | `c.input.params.id` | `input: { params: SomeSchema }` |
| `@Query('q') q: string` | `c.input.query.q` | `input: { query: SomeSchema }` |
| `@Body() dto: CreateUserDto` | `c.input.body` | `input: { body: SomeSchema }` |
| `@Headers('authorization')` | `c.input.headers.authorization` | `input: { headers: SomeSchema }` |

`c.input` é totalmente tipado a partir dos schemas — não há decorator por parâmetro
nem `@Req()`/`@Res()` por padrão (o contexto Hono cru está disponível como
`c.raw` se você precisar dele). Toda rota **deve** declarar tanto `input` quanto `output`
([ADR-0003](/adr/0003-mandatory-input-output-schemas)); uma rota que não lê
nada ainda assim escreve `input: {}` explicitamente.

## DTOs, pipes & validação → schemas Zod

Um DTO do NestJS é uma classe anotada com decorators de `class-validator`, validada por
um `ValidationPipe` (geralmente global):

```ts
// NestJS
export class CreateUserDto {
  @IsString()
  @MinLength(1)
  name: string

  @IsEmail()
  email: string
}
```

Em Kata o DTO **é** o schema. Schemas Zod ficam em `<domain>.schema.ts`,
nunca inline na rota ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)),
e o tipo `z.infer` fica ao lado deles para que um único import traga tanto o
validador de runtime quanto o tipo de tempo de compilação. Isso espelha
[`examples/hello/src/modules/users/users.schema.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.schema.ts):

```ts
// src/modules/users/users.schema.ts
import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
})

export const CreateUserBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
})

// Params também ganham seu próprio schema — nunca inline na rota (ADR-0005).
export const UserIdParamSchema = z.object({ id: z.string() })

export type User = z.infer<typeof UserSchema>
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>
```

Validadores comuns traduzem-se diretamente:

| class-validator | Zod |
|---|---|
| `@IsString()` | `z.string()` |
| `@IsEmail()` | `z.string().email()` |
| `@MinLength(1)` / `@Min(1)` | `.min(1)` / `.gte(1)` |
| `@IsOptional()` | `.optional()` |
| `@IsInt()` | `z.number().int()` |
| `@IsEnum(Role)` | `z.enum(['admin', 'user'])` |
| `@ValidateNested()` + DTO aninhado | um `z.object({ ... })` aninhado |
| `@Type(() => Number)` em um query param (`ParseIntPipe`) | `z.coerce.number()` |
| um pipe de transform custom | `.transform((v) => ...)` no schema |

Duas diferenças que vale internalizar:

- **A validação é obrigatória e por rota**, não um pipe global no qual você opta. Você
  não pode esquecê-la — omitir `input` ou `output` é um erro de TypeScript
  ([ADR-0003](/adr/0003-mandatory-input-output-schemas)).
- **A resposta também é validada.** Depois que seu handler retorna um valor, Kata
  o verifica contra `output` e responde `500 internal_output_shape_mismatch` se
  ele desviar — não há equivalente no NestJS. Veja [errors.md](/pt/cookbook/errors).

Quando o input falha, Kata nunca chama seu handler; ele retorna o envelope `422`
`validation_failed` com issues chaveadas por seção (`params` / `query` /
`body` / `headers`). A forma exata está documentada em [errors.md](/pt/cookbook/errors)
e é assertada em [`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl).

## Providers → injeção de dependência

Um provider do NestJS é uma classe `@Injectable()` conectada por um módulo e injetada
via construtor; o container IoC constrói o grafo no boot.

```ts
// NestJS
@Injectable()
export class UsersService {
  constructor(private readonly db: DbClient) {}
  findOne(id: string) {
    return this.db.user.findUnique({ where: { id } })
  }
}

@Module({
  providers: [UsersService, { provide: DbClient, useFactory: () => makeDb() }],
  controllers: [UsersController],
})
export class UsersModule {}
```

Kata não tem container nem injeção via construtor. Uma dependência de vida longa é um
slot `singleton` no `defineContext` central, e o "service" é um conjunto de
**funções puras** que recebem a dependência como argumento — trivial de testar unitariamente
sem subir um servidor. Este é o padrão de [database.md](/pt/cookbook/database):

```ts
// src/db.ts — modele o cliente como um type + factory (sem classe; ADR-0002)
import type { User } from './modules/users/users.schema'

export type Db = {
  findUser: (id: string) => Promise<User | null>
  insertUser: (user: User) => Promise<void>
}

export function makeDb(env: NodeJS.ProcessEnv): Db {
  // Troque o store em memória pelo seu driver real (Prisma, Drizzle, pg, …).
  void env
  const store = new Map<string, User>()
  return {
    findUser: async (id) => store.get(id) ?? null,
    insertUser: async (user) => {
      store.set(user.id, user)
    },
  }
}
```

```ts
// src/modules/users/users.service.ts — funções puras, sem import de framework
import type { Db } from '../../db'
import type { CreateUserBody, User } from './users.schema'

export async function findUser(db: Db, id: string): Promise<User | null> {
  return db.findUser(id)
}

export async function createUser(db: Db, input: CreateUserBody): Promise<User> {
  const user: User = { id: crypto.randomUUID(), ...input }
  await db.insertUser(user)
  return user
}
```

Registre o cliente uma vez (`db: singleton(makeDb(process.env))`, mostrado em
[o contexto compartilhado](#the-shared-context-file)) e leia-o em um handler com
`c.get('db')`. Como as receitas de provider do NestJS mapeiam:

| provider NestJS | Kata |
|---|---|
| `useValue: x` | `singleton(x)` |
| `useFactory: () => makeX(env)` (sync) | `singleton(makeX(env))` — roda uma vez na inicialização |
| `useClass: XService` | uma factory `makeX()` + `type X`, registrada como `singleton(makeX())` |
| param de construtor `@Inject(TOKEN)` | `c.get('token')` — uma chave string em `defineContext` |

`c.get('db')` é monomórfico — sempre `Db`, nunca `Promise<Db>` ou
`Db | undefined` — e **só compila para chaves que você registrou**
([ADR-0004](/adr/0004-di-via-scoped-slots)). Não há tokens de provider,
nem `@Optional()`, nem resolvedor de dependência circular: a registry é um único objeto
plano que você pode ler de cima a baixo.

> **Providers assíncronos.** O `useFactory` do Nest pode ser `async`; o `singleton` do
> Kata recebe um valor pronto. Para setup que precisa de `await` (ex.: conectar um pool antes
> da primeira requisição), faça isso em `main.ts` antes de `createApp`, ou conecte de forma
> lazy dentro do cliente. Não há fase de provider assíncrono.

## Providers com escopo de requisição

Um provider `Scope.REQUEST` do NestJS é reinstanciado por requisição pelo
container. Em Kata, o estado de requisição é um slot `scoped<T>()` **declarado**
antecipadamente e **populado** por um middleware — Padrão C em
[ADR-0004](/adr/0004-di-via-scoped-slots). O slot é `currentUser` em
[o contexto compartilhado](#the-shared-context-file); o middleware o preenche (veja a
próxima seção). Um handler então o lê sincronamente com `c.get('currentUser')`,
exatamente como um singleton.

A única regra sem equivalente no NestJS: o middleware provedor deve estar na
cadeia `use:` da rota. Ler um scoped slot que nenhum middleware definiu lança erro em
runtime (e é capturado pela regra de lint `kata/scoped-slot-not-provided`). Tratamento
completo em [auth.md](/pt/cookbook/auth).

## Guards, interceptors → middleware

NestJS tem três mecanismos transversais distintos — guards, interceptors e
middleware. Kata unifica todos eles em um só: `defineMiddleware`. Um middleware
recebe o contexto `c` e `next`; ele pode rodar lógica antes de `await next()`,
depois dele, ou curto-circuitar retornando uma `Response` em vez de chamar `next()`.

### Guard → um middleware que permite ou nega

Um guard do NestJS retorna um booleano (ou lança) para permitir/negar:

```ts
// NestJS
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest()
    return Boolean(req.headers['x-user-id'])
  }
}
// uso: @UseGuards(AuthGuard)
```

Em Kata, "negar" significa retornar uma `Response`; "permitir" significa chamar `next()`. Um guard
que também disponibiliza o usuário autenticado declara o scoped slot que
`provides`. O shim abaixo permanece mínimo para mostrar o mecanismo — `c.header`,
`c.set`, `provides`; o middleware real de
[`examples/hello`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/middlewares/auth.ts)
verifica um JWT com `jwtAuth` em vez disso (veja [auth.md](/pt/cookbook/auth)):

```ts
// um shim apenas de header — veja auth.md para a versão real com jwtAuth
import { defineMiddleware } from '../context'

export const requireUser = defineMiddleware({
  provides: ['currentUser'] as const, // os scoped slots que este middleware preenche
  handler: async (c, next) => {
    const userId = c.header('x-user-id') // c.header é exclusivo de middleware
    if (!userId) return c.error('unauthorized', 'Missing x-user-id header', { status: 401 })

    c.set('currentUser', { id: userId, name: `User-${userId}`, email: `user-${userId}@example.test` })
    await next() // roda o resto da cadeia + o handler
  },
})
```

Uma rota opta por ele via `use:`, e a ordem importa — middlewares rodam da esquerda para a direita, então
um guard de autorização que lê `currentUser` deve vir **depois** daquele que
o fornece (a ordem em `use:` é o contrato):

```ts
// src/modules/users/users.route.ts
export const meRoute = defineRoute({
  method: 'GET',
  path: '/me',
  use: [requireUser], // ≈ @UseGuards(AuthGuard)
  input: {},
  output: UserSchema,
  handler: async (c) => c.get('currentUser'), // User tipado, definido pelo middleware
})
```

Um guard de role que depende do usuário não fornece nada e lê o slot que o
middleware anterior definiu — veja a [receita de autorização](/pt/cookbook/auth#authorization-a-role-guard-that-depends-on-the-user).

### Interceptor → um middleware em torno de `next()`

Um interceptor do NestJS envolve o handler para adicionar timing, logging ou moldagem
de resposta. As metades antes/depois viram código de cada lado de `await next()`:

```ts
// src/middlewares/timing.ts
import { defineMiddleware } from '../context'

export const timing = defineMiddleware({
  provides: [] as const,
  handler: async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    c.get('logger').info(`${c.raw.req.method} ${c.raw.req.path} — ${ms}ms`)
  },
})
```

Dois limites honestos versus um interceptor do NestJS:

- **Um middleware não pode ler nem reescrever o corpo da resposta do handler.** O
  valor de retorno do handler não é devolvido ao middleware após `next()`, então
  o clássico interceptor "envolva toda resposta em `{ data: ... }`" não tem equivalente
  direto — coloque essa forma no handler e no schema `output` em vez disso.
- **Headers de resposta** *podem* ser definidos pelo contexto Hono e sobrevivem até a
  resposta final — é exatamente assim que os middlewares embutidos `cors()` e `secureHeaders()`
  funcionam (verificado em [`echo.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/echo/echo.hurl)).
  Recorra a esses embutidos em vez de escrever lógica de header na mão — e aplique
  o endurecimento transversal **uma vez** pela cadeia global `middlewares`
  ([ADR-0012](/adr/0012-app-level-middleware)) em vez de por rota:

```ts
// src/main.ts — endurecimento declarado uma vez, para o app inteiro (ADR-0012)
import { bodyLimit, cors, secureHeaders } from 'katajs'

import { createApp } from './context'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

export const app = createApp({
  modules: [users, echo],
  // Roda antes do `use:` de cada rota — sem copy-paste por rota.
  middlewares: [cors(), secureHeaders(), bodyLimit({ maxSize: 8 * 1024 })],
})
```

  A cadeia global compõe com a da própria rota como `[...middlewares, ...use]`, então uma
  rota que precisa de um middleware só para si ainda o lista em `use:`.
  [`examples/hello`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/main.ts) aplica exatamente este trio
  para o app inteiro.

## Exception filters → `c.error`

NestJS centraliza o mapeamento de erros em exception filters e uma hierarquia de
`HttpException`: você faz `throw new NotFoundException()` e um filter renderiza o corpo.

Kata não tem mapeamento de tipo-de-exceção→resposta. Para um erro **esperado**, retorne
`c.error(code, message, { status })` diretamente do handler (ou middleware).
Ele constrói o único envelope unificado — `{ error, message, issues? }` — que todo
4xx/5xx do Kata produz ([ADR-0008](/adr/0008-unified-error-response-envelope)):

```ts
// NestJS:  throw new NotFoundException('No user with that id')
// Kata:
if (!user) return c.error('not_found', 'No user with that id', { status: 404 })
```

`c.error` está disponível tanto no contexto de rota quanto no de middleware. `status`
tem padrão `400`, e você pode anexar erros estruturados de campo via
`{ issues }`. Retornar uma `Response` (que é o que `c.error` é) curto-circuita a
rota — ela é enviada literalmente e **não** é verificada contra `output`.

Para um erro **inesperado**, uma fronteira global de erro captura qualquer throw que
escape de um handler ou middleware e o serializa como um envelope genérico
`500 internal_error` — nunca a página padrão de texto/HTML do Hono, e nunca
vazando a mensagem subjacente (ADR-0008, Alternativa D). Isso é exercitado pela
rota `/boom` em [`users.hurl`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.hurl).
Como um throw vira um 500 opaco, **prefira `c.error` para qualquer coisa que o cliente
deva entender** — reserve o throw para bugs genuínos.

Para contratos por status, `output` pode ser um mapa status→schema
(`{ 200: UserSchema, 404: ErrorBodySchema }`,
[ADR-0011](/adr/0011-multi-status-output-schemas)): um retorno simples é o corpo 200,
e um `c.json(body, status)` / `c.error(...)` cujo status é declarado é
validado contra o schema daquele status (Kata vem com `ErrorBodySchema` para o
envelope unificado). Um único schema `output` ainda funciona inalterado — suas `Response`s
de erro contornam a validação.

## Modules → o layout de pastas

Um `@Module` do NestJS é uma fronteira de injeção de dependência: ele lista `providers`,
`controllers`, `imports` e `exports`, e o container escopa a visibilidade dos providers
a ele.

Um "module" do Kata **não** é um escopo de injeção. É uma pasta sob
`src/modules/<domain>/` contendo a rota, o service, o schema, o teste e os arquivos Hurl
de um domínio ([AGENTS.md](https://github.com/VicenzoMF/kata/blob/main/AGENTS.md)), mais sua registração em
`createApp`. Toda a injeção de dependência é o único e global `defineContext` — então
não há lista de `providers` por módulo, nem `exports`, nem grafo de `imports` para
conectar. Para "usar um provider de outro módulo", você simplesmente faz `c.get('it')`; ele
já está na registry central.

```
src/
├── context.ts                # toda a registry de DI (≈ os providers de todos os seus módulos)
├── main.ts                   # createApp({ modules: [...] })  (≈ AppModule)
├── middlewares/
└── modules/<domain>/
    ├── <domain>.route.ts      # chamadas defineRoute   (≈ controller)
    ├── <domain>.service.ts    # funções puras          (≈ provider)
    ├── <domain>.schema.ts     # schemas Zod            (≈ DTOs)
    ├── <domain>.test.ts       # testes unitários
    └── <domain>.hurl          # E2E de API
```

Um "module" passado a `createApp` é simplesmente o import de namespace de um
arquivo `.route.ts`; Kata registra cada rota que ele exporta.

## Bootstrap

```ts
// NestJS
const app = await NestFactory.create(AppModule)
app.useGlobalPipes(new ValidationPipe())
await app.listen(3000)
```

```ts
// src/main.ts — espelha examples/hello
import { serve } from '@hono/node-server'

import { createApp, k } from './context'
import * as echo from './modules/echo/echo.route'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users, echo] })

const port = Number(process.env['PORT'] ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  k.registry.logger.__value.info(`listening on http://localhost:${info.port}`)
})
```

Os globais do `NestFactory` mapeiam de forma limpa:

- `useGlobalPipes(new ValidationPipe())` → nada a fazer; a validação já é obrigatória
  por rota.
- `useGlobalGuards` / `useGlobalInterceptors` / um middleware verdadeiramente global →
  declare-os uma vez em `createApp({ middlewares: [...] })`
  ([ADR-0012](/adr/0012-app-level-middleware)): uma cadeia de `Middleware` do Kata que
  roda antes do `use:` de cada rota, compartilhando o mesmo contrato, o mesmo store
  scoped por requisição e a mesma semântica de curto-circuito. Os embutidos de endurecimento ficam aqui —
  `middlewares: [cors(), secureHeaders(), bodyLimit()]`.
- Um middleware Hono de terceiros arbitrário (ou o tratamento completo de preflight `OPTIONS`
  de CORS) → `createApp` ainda retorna um app Hono simples, então `app.use('*', ...)`
  também funciona, e continua sendo o ponto recomendado para o preflight de CORS para o app inteiro (veja a
  nota em [`packages/kata/src/middlewares/cors.ts`](https://github.com/VicenzoMF/kata/blob/main/packages/kata/src/middlewares/cors.ts)).

## O que Kata intencionalmente NÃO tem

Sendo explícito, para que você pare de procurar por estes:

| O que você vai sentir falta do NestJS | Por que sumiu | Faça isto em vez disso |
|---|---|---|
| Classes & decorators (`@Controller`, `@Injectable`, `@Module`, `@Get`, `@Body`) | Fluxo de controle oculto que não pode ser grepado nem mecanicamente verificado ([ADR-0002](/adr/0002-no-classes-no-decorators)) | Funções + objetos simples: `defineRoute`, `defineMiddleware`, `defineContext` |
| Container IoC em runtime & `reflect-metadata` | Custo de cold-start; o verificador perde sua propriedade de "um grep responde a pergunta" ([ADR-0004](/adr/0004-di-via-scoped-slots)) | Um único `defineContext` estático; `c.get('key')` é uma busca tipada |
| Providers por módulo / `imports` / `exports` | Módulos são pastas, não escopos de DI | Uma única registry plana e global — tudo está em `defineContext` |
| Escopos de injeção além de singleton & request (`Scope.TRANSIENT`) | Dois tempos de vida previsíveis mantêm `c.get` monomórfico | `singleton` (processo) ou `scoped` (requisição, definido por um middleware) |
| Providers assíncronos & lifecycle hooks (`OnModuleInit`, `OnApplicationShutdown`) | Não há container para conduzir um lifecycle | Factories `singleton` eager na inicialização; teardown via `gracefulShutdown` (`katajs/node`) em `main.ts` ([ADR-0014](/adr/0014-lifecycle-shutdown), [database.md](/pt/cookbook/database#closing-the-pool-on-shutdown)) |
| Interceptors que transformam o corpo da resposta / RxJS | O valor de retorno do handler não é exposto ao middleware | Molde a resposta no handler + `output`; use middleware para trabalho antes/depois e headers |
| Exception filters & a hierarquia de `HttpException` | Não há camada de mapeamento tipo-de-exceção→resposta | `c.error(code, message, { status })`; throws não capturados → 500 genérico ([ADR-0008](/adr/0008-unified-error-response-envelope)) |
| Pipes como uma camada separada (`ValidationPipe`, pipes custom) | A validação é obrigatória por rota, não opcional | Os schemas Zod `input` da rota; `z.coerce` / `.transform()` para coerção |
| OpenAPI automático do `@nestjs/swagger` | Um não-objetivo deliberado — Kata não é dono do seu pipeline de docs, não é uma lacuna do roadmap ([non-goals.md](/pt/cookbook/non-goals)) | As rotas já têm schemas Zod `input` / `output`; alimente-os a um gerador (`@asteasolutions/zod-to-openapi`, `@hono/zod-openapi`) e sirva-o como uma rota ou via `app.use` |
| `Test.createTestingModule()` | Services são funções puras, não gerenciadas por container | Chame a função com uma dependência falsa feita na mão ([database.md](/pt/cookbook/database#4-test-the-service-with-a-fake-client)) |
| Múltiplas formas de resposta por rota | Schemas de output por status ([ADR-0011](/adr/0011-multi-status-output-schemas)) | `output: { 200: UserSchema, 404: ErrorBodySchema }` — tipado para `hc` e validado em runtime |

O fio condutor: Kata troca a flexibilidade de runtime do NestJS por **verificabilidade
estática**. Toda restrição acima existe para que uma rota, suas dependências e
seu contrato sejam inspecionáveis pela forma — por um humano, por um agente e pelo
harness `kata verify`.

## Pegadinhas para refugiados do NestJS

- **`c.set` e `c.header` são exclusivos de middleware.** O contexto do handler de rota tem
  `c.get`, `c.input`, `c.json`, `c.error` e `c.raw` — handlers consomem scoped
  slots, eles não os preenchem.
- **Uma leitura scoped precisa de um provedor em `use:`.** `c.get('currentUser')` lança erro em
  runtime se nenhum middleware na cadeia da rota o definiu — não há container para
  auto-instanciá-lo ([auth.md](/pt/cookbook/auth#gotchas)).
- **A ordem do middleware é o contrato.** Auth antes do guard de role, toda vez —
  da esquerda para a direita.
- **Valor de retorno vs. `Response`.** Retornar um valor simples o valida contra
  `output` e envia `200`; retornar `c.error(...)` / `c.json(...)` o envia
  literalmente com seu status, sem validação.
- **Prefira `c.error` em vez de `throw`.** Um erro lançado vira um `500 internal_error`
  opaco (nenhum detalhe vazado); só bugs genuínos devem lançar.
- **Singletons são eager.** `makeDb(process.env)` roda quando `context.ts` é importado
  pela primeira vez, não no primeiro `c.get`. Faça a inicialização ali; mantenha a lógica de requisição fora
  da factory ([database.md](/pt/cookbook/database#gotchas)).
- **Há um único `defineContext`.** Não procure por providers por módulo — a
  registry inteira é um único objeto.

## Veja também

- [Quickstart do README](https://github.com/VicenzoMF/kata/blob/main/README.md#quickstart) — o mesmo app em seis arquivos.
- [Autenticação](/pt/cookbook/auth) — scoped slots e guards de role a fundo.
- [Acesso a banco de dados](/pt/cookbook/database) — singletons, services puros, testes com cliente falso.
- [Erros & validação](/pt/cookbook/errors) — os envelopes 422 / 500 em detalhe.
- ADRs: [0002 (sem classes/decorators)](/adr/0002-no-classes-no-decorators),
  [0003 (schemas obrigatórios)](/adr/0003-mandatory-input-output-schemas),
  [0004 (DI via slots)](/adr/0004-di-via-scoped-slots),
  [0005 (DTOs em arquivos de schema)](/adr/0005-dtos-in-separate-schema-file),
  [0008 (envelope de erro)](/adr/0008-unified-error-response-envelope).
- [`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello) — a referência executável que este guia acompanha.
