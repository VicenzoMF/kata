---
layout: home

hero:
  name: Kata
  text: APIs web disciplinadas sobre Hono.
  tagline: Opinativo como o NestJS, funcional como um script, verificável como um sistema de tipos — feito para que agentes de IA e humanos produzam código correto de primeira.
  image:
    light: /enso.svg
    dark: /enso-dark.svg
    alt: Kata — um ensō selado com um hanko de cinábrio
  actions:
    - theme: brand
      text: Começar
      link: /pt/guide/what-is-kata
    - theme: alt
      text: Início rápido
      link: /pt/guide/quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/VicenzoMF/kata

features:
  - title: DI estática
    details: Toda dependência é declarada uma vez em defineContext. c.get('key') só compila para as chaves que você registrou — suas dependências são estaticamente enumeráveis, não buscas por string que escapam do sistema de tipos.
  - title: Schemas obrigatórios
    details: Toda route declara schemas Zod de input e output. O lint falha se qualquer um faltar; o input é validado antes do seu handler, o output depois dele. O formato errado nunca chega ao cliente.
  - title: Layout travado
    details: "modules/&lt;domain&gt;/&lt;domain&gt;.{route,service,schema,hurl,test}.ts. Sem handlers soltos — toda route, service, schema e test é localizável por glob."
  - title: Nativo no harness
    details: kata verify roda em um hook PostToolUse de menos de 100ms e retorna feedback estruturado em ERROR/WHY/FIX, para que agentes se autocorrijam na próxima rodada. As restrições são o fosso.
---

## Por que mais um framework

|                                          |  Nest  | Elysia | Template Hono + Zod |  Kata  |
| ---------------------------------------- | :----: | :----: | :-----------------: | :----: |
| Apenas funcional                         |   ❌   |   ✅   |         ✅          |   ✅   |
| Roda sobre Hono (Node · Bun · Deno · Edge) |   ❌   |   ❌   |         ✅          |   ✅   |
| Schemas obrigatórios (impostos pelo lint) |   ❌   |   ⚠️   |         ❌          |   ✅   |
| DI estaticamente enumerável              |   ❌   |   ⚠️   |         ❌          |   ✅   |
| Hooks de harness entregues nativamente   |   ❌   |   ❌   |         ❌          |   ✅   |

[Por que Kata, em profundidade →](/pt/guide/why-kata)

## Seis arquivos para uma API totalmente tipada

Um módulo tem exatamente um lugar para cada responsabilidade — schema, service, route — então toda
route, DTO e test é localizável por glob, e o `kata verify` consegue checar todo o
contrato em bem menos de 100&nbsp;ms.

```
src/
├── context.ts                # defineContext({ ... }) — o único registry de DI
└── modules/users/
    ├── users.schema.ts        # DTOs Zod
    ├── users.service.ts       # funções puras
    └── users.route.ts         # defineRoute — schemas de input + output
```

[Siga o início rápido de seis arquivos →](/pt/guide/quickstart)
