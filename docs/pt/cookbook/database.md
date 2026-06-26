# Receita: Acesso a banco de dados

**Problema:** abrir uma conexão de banco de dados (ou qualquer cliente de vida
longa — cache, mailer, fila) uma única vez e alcançá-la a partir de qualquer
handler sem recriá-la por requisição nem recorrer a um global no nível do módulo.

**Padrão:** um **slot singleton** em `defineContext`. Conforme o
[ADR-0004](/adr/0004-di-via-scoped-slots), singletons vivem durante todo o tempo
de vida do processo; `c.get('db')` retorna a mesma instância em toda requisição,
de forma síncrona e totalmente tipada.

## 1. Defina um cliente tipado

Kata é funcional — sem classes, sem decorators ([ADR-0002](/adr/0002-no-classes-no-decorators)).
Modele o cliente como uma interface mais uma função factory. Mantenha a superfície
pequena e concreta; `any` é proibido.

```ts
// src/db.ts
import type { User } from './modules/users/users.schema'

export type Db = {
  findUser: (id: string) => Promise<User | null>
  insertUser: (user: User) => Promise<void>
  // Libere o pool de conexões no shutdown — veja "Fechando o pool no shutdown".
  close: () => Promise<void>
}

export function makeDb(env: NodeJS.ProcessEnv): Db {
  // Troque este store em memória pelo seu driver real (node-postgres, Drizzle,
  // Prisma, …). `env` é lido uma vez, aqui — não dentro dos handlers.
  void env
  const store = new Map<string, User>()
  return {
    findUser: async (id) => store.get(id) ?? null,
    insertUser: async (user) => {
      store.set(user.id, user)
    },
    // Um driver real aguarda `pool.end()` aqui; o stub em memória não tem nada a liberar.
    close: async () => {},
  }
}
```

## 2. Registre-o como singleton

`singleton(value)` envolve uma instância pronta para uso. A factory executa quando
o módulo que define o contexto é avaliado pela primeira vez, então a conexão é
estabelecida uma única vez na inicialização.

```ts
// src/context.ts
import { defineContext, scoped, singleton } from 'kata'

import { makeDb } from './db'
import type { User } from './modules/users/users.schema'

export const k = defineContext({
  db: singleton(makeDb(process.env)),
  currentUser: scoped<User>(),
})

export const { defineRoute, defineMiddleware, createApp } = k
```

## 3. Leia-o num handler, passe-o a um serviço puro

Resolva o cliente no handler da rota com `c.get('db')`, depois entregue-o a uma
função de serviço. Manter o serviço **puro** — ele recebe `db` como argumento em
vez de importar o contexto — é o que o torna testável de forma unitária sem subir
um servidor HTTP (o layout em
[`examples/hello`](https://github.com/VicenzoMF/kata/tree/main/examples/hello) mantém os serviços livres de imports
de framework exatamente por essa razão).

```ts
// src/modules/users/users.service.ts
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

```ts
// src/modules/users/users.schema.ts  (adicione o schema de params aqui, nunca inline)
export const UserIdParamSchema = z.object({ id: z.string() })
```

```ts
// src/modules/users/users.route.ts
import { defineRoute } from '../../context'

import { CreateUserBodySchema, UserIdParamSchema, UserSchema } from './users.schema'
import { createUser, findUser } from './users.service'

export const getUserRoute = defineRoute({
  method: 'GET',
  path: '/users/:id',
  input: { params: UserIdParamSchema },
  output: UserSchema,
  handler: async (c) => {
    const user = await findUser(c.get('db'), c.input.params.id)
    if (!user) return c.error('not_found', 'User not found', { status: 404 })
    return user
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

> Schemas são importados de `users.schema.ts`, nunca escritos inline numa rota
> ([ADR-0005](/adr/0005-dtos-in-separate-schema-file)).

## 4. Teste o serviço com um cliente falso

Como o serviço recebe `db` como parâmetro, um teste unitário passa um fake feito à
mão — sem rede, sem contexto, sem Hono. Isso espelha
[`users.service.test.ts`](https://github.com/VicenzoMF/kata/blob/main/examples/hello/src/modules/users/users.service.test.ts).

```ts
// src/modules/users/users.service.test.ts
import { describe, expect, it } from 'vitest'

import type { Db } from '../../db'
import { findUser } from './users.service'

const fakeDb: Db = {
  findUser: async (id) => (id === '1' ? { id: '1', name: 'Ada', email: 'ada@example.com' } : null),
  insertUser: async () => {},
}

describe('users.service', () => {
  it('findUser returns null for unknown ids', async () => {
    expect(await findUser(fakeDb, 'nope')).toBeNull()
  })
})
```

## Por que singleton, e não scoped

| | `singleton(value)` | `scoped<T>()` |
|---|---|---|
| Tempo de vida | processo inteiro | uma requisição HTTP |
| Criado | uma vez, no `defineContext` | por um middleware, por requisição |
| `c.get` retorna | a mesma instância sempre | o valor que o middleware definiu com `set` |
| Use para | db / cache / logger / mailer | usuário atual / tenant / id da requisição / tx ativa |

`c.get('db')` é monomórfico — sempre `Db`, nunca `Promise<Db>` ou
`Db | undefined` — que é a propriedade de inferência que o ADR-0004 foi escolhido
para preservar.

## Estado de DB por requisição (transações)

Um pool de conexões é um singleton, mas uma transação é por requisição — então é
um slot **scoped**, aberto e commitado por um middleware:

```ts
// context.ts:  tx: scoped<Transaction>()
export const withTransaction = defineMiddleware({
  provides: ['tx'] as const,
  handler: async (c, next) => {
    const tx = await c.get('db').begin()
    c.set('tx', tx)
    await next() // a fiação de commit/rollback vive aqui; veja a nota abaixo
  },
})
```

Um commit-no-sucesso / rollback-na-falha robusto depende do middleware enxergar o
desfecho do handler — e a fronteira global de erros
([#62](https://github.com/VicenzoMF/kata/issues/62)) torna esse desfecho visível:
envolva `await next()` num `try/catch` para fazer rollback (e relançar) num throw,
e fazer rollback de qualquer transação que o handler deixou sem commit. O
[middleware de transação do `examples/shop`](https://github.com/VicenzoMF/kata/blob/main/examples/shop/src/middlewares/transaction.ts)
mostra o padrão completo.

## Fechando o pool no shutdown

Um singleton é aberto uma vez na inicialização e vive durante todo o processo,
então fechá-lo é uma preocupação de *processo*, não de cada requisição — não há
hook de teardown por requisição em que pendurá-lo. Um app que ignora `SIGTERM`
(um `docker stop`, uma rotação de pod do Kubernetes) é morto no meio do voo:
requisições em andamento são descartadas e o pool nunca fecha. Conecte
`gracefulShutdown` do subpath somente-Node **`kata/node`** no `main.ts` — ele para
de aceitar conexões, drena as requisições em andamento e então executa seu
`onClose` ([ADR-0014](/adr/0014-lifecycle-shutdown)):

```ts
// src/main.ts
import { serve } from '@hono/node-server'
import { gracefulShutdown } from 'kata/node'

import { createApp, k } from './context'
import * as users from './modules/users/users.route'

const app = createApp({ modules: [users] })
const server = serve({ fetch: app.fetch, port: Number(process.env['PORT'] ?? 3000) })

gracefulShutdown(server, {
  onClose: async () => {
    await k.resolve('db').close() // fecha o pool *depois* do drain
  },
})
```

`onClose` executa **depois** do drain, então nenhum handler ativo perde seu pool
no meio de uma query, e a ordem de teardown continua sua: sequencie-a explicitamente
(faça flush de métricas, drene uma fila, *então* feche o pool — o inverso da ordem
de construção). Kata não é dono de nenhum registry de dispose; `gracefulShutdown` é
dono apenas da fiação sempre idêntica — o trap do sinal, o drain e um timer de
force-exit (`timeoutMs`, padrão 10 s) para uma conexão que se recusa a fechar. O
[bootstrap do `examples/shop`](https://github.com/VicenzoMF/kata/blob/main/examples/shop/src/main.ts) conecta isso contra
o stub do store de ponta a ponta.

## Pegadinhas

- **Singletons são eager.** `makeDb(process.env)` executa quando `context.ts` é
  importado pela primeira vez, não preguiçosamente no primeiro `c.get`. Faça o
  setup de conexão ali; não coloque lógica específica de requisição na factory.
- **O ciclo de vida está fora da requisição.** Um singleton não tem hook de
  teardown por requisição; fechar o pool é uma preocupação de processo tratada no
  `main.ts` com `gracefulShutdown` — veja [Fechando o pool no shutdown](#closing-the-pool-on-shutdown).
- **Leia a configuração na borda.** Passe `env` para `makeDb` uma vez; mantenha
  `process.env` fora dos handlers e serviços para que permaneçam puros e testáveis.
- **`c.get('db')` só compila se `'db'` estiver em `defineContext`.** Uma chave não
  registrada é tanto um erro de tipo quanto um throw em runtime (`kata: key 'db' not registered in
  defineContext`) — e a regra de lint `kata/context-key-not-registered` também a sinaliza.
