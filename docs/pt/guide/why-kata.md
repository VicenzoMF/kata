---
title: Por que Kata
description: Por que um framework que tira liberdade — e onde ele para.
---

# Por que Kata

A maioria dos frameworks web compete em liberdade. Eles te dão mais formas de
ligar uma rota, registrar uma dependência ou posicionar um arquivo. O Kata faz o
oposto. Ele remove escolhas, de propósito, porque as escolhas são de onde vem o
código errado.

## O problema: liberdade produz código errado

O Hono é pequeno e sem opinião. Isso é uma força para o runtime e um passivo para
um time. Sem nada que imponha estrutura, todo colaborador — humano ou agente —
inventa a sua própria. Schemas escorregam inline para dentro dos arquivos de rota.
Uma dependência é lida de um singleton em nível de módulo num lugar e de uma
closure em outro. Handlers ficam onde quer que a última pessoa os tenha largado.
Algumas rotas validam sua saída; a maioria não.

Isso não é um problema de disciplina que você conserta com um guia de estilo. A
liberdade é a causa. Quando o framework permite dez formatos, um LLM vai produzir
uma mistura plausível dos dez, e um revisor tem que pegar a diferença lendo. O
custo se acumula: toda convenção frouxa é um lugar onde a próxima mudança pode dar
errado, e não há mecanismo que diga que deu.

A aposta do Kata é que, para construir serviços HTTP, a liberdade marginal vale
menos do que o custo de policiá-la. Então ele escolhe um formato para cada decisão
e transforma o resto em erro de tipo.

## Como o Kata difere

| | Nest | Elysia | Template Hono + Zod | Kata |
|---|---|---|---|---|
| Apenas funcional | ❌ | ✅ | ✅ | ✅ |
| Roda sobre Hono (Node, Bun, Deno, Edge) | ❌ | ❌ (Bun) | ✅ | ✅ |
| Schemas obrigatórios (impostos pelo lint) | ❌ | ⚠️ | ❌ | ✅ |
| DI estaticamente enumerável | ❌ | ⚠️ | ❌ | ✅ |
| Hooks de harness entregues nativamente | ❌ | ❌ | ❌ | ✅ |

Leia a tabela pelas colunas:

- **Nest** é opinativo, mas as opiniões são classes, decorators e um container IoC
  em runtime. Dependências são resolvidas por reflexão em runtime, então a ligação
  não é estaticamente enumerável, e schemas são uma convenção em que você opta por
  rota. O Kata mantém o caráter opinativo e descarta o maquinário.
- **Elysia** é funcional e validation-first, mas é só para Bun e sua disciplina de
  schema e DI é por convenção, não imposta pelo lint (`⚠️`). Nada quebra o build
  quando uma rota é entregue sem contrato.
- **Um template Hono + Zod** roda em qualquer lugar e é funcional, mas um template é
  um ponto de partida, não uma restrição. A estrutura do dia seguinte é o que cada
  colaborador decidir, e não há harness incluído.
- **Kata** é a única coluna que é `✅` de cima a baixo: apenas funcional, roda em
  qualquer lugar onde o Hono roda, schemas e DI que o harness de lint de fato impõe,
  e os hooks de harness entregues com o framework em vez de reinventados por projeto.

A última linha é a que nenhum outro framework tem. Ela também é o ponto.

## Menos liberdade, de propósito

O Kata reduz o espaço de design a três invariantes, e faz isso porque esses três
são mecanicamente verificáveis num hook `PostToolUse` do Claude Code ou do Codex em
menos de 100ms:

1. **DI estática.** Toda dependência é declarada em um único `defineContext({...})`.
   Sem buscas por chave em string que escapam do sistema de tipos — `c.get('key')`
   só compila para uma chave que você registrou.
2. **Schemas obrigatórios.** Toda rota declara schemas `input` e `output`. Omitir
   qualquer um é um erro de TypeScript, e o lint falha por isso.
3. **Layout de pastas travado.** O código fica em
   `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts`. Sem handlers
   soltos; toda rota, service, schema e teste é encontrável por glob.

Cada restrição é escolhida para ser *enumerável*. Um verificador não precisa
entender sua lógica de negócio para checá-las — ele faz grep do layout, lê o
`defineContext` e confirma que cada `defineRoute` tem ambos os schemas. É por isso
que o `kata verify` consegue rodar a cada escrita de arquivo e retornar o JSON
`hookSpecificOutput.additionalContext` que o agente usa para se autocorrigir, antes
que um único teste rode.

::: tip Isto é engenharia de harness
O Kata é construído sobre uma premissa simples: **imponha qualidade com mecanismos,
não com prompts.** Uma regra que vive num prompt ou num guia de contribuição se
desgasta em um punhado de sessões — para um agente e para um humano. Uma regra que é
um erro de tipo, um lint que falha ou um commit bloqueado, não. Os invariantes do
Kata existem precisamente para que possam ser impostos por máquina.
:::

O raciocínio é o mesmo que o Kata aplicou a si próprio. A [ADR-0007](/adr/0007-self-apply-harness-before-feature-work)
fez de construir o harness um marco que *bloqueava* todo trabalho de feature, sob o
princípio de que "escalar sem um harness cria dívida cognitiva acumulada, não
alavancagem acumulada." O framework é seu próprio primeiro usuário: o loop que
mantém seu código correto é o loop sobre o qual o próprio desenvolvimento do Kata
roda.

Para a mecânica — o que o `kata verify` checa, como os hooks se conectam ao Claude
Code e ao Codex, e como o feedback chega ao agente — veja [o guia do harness](/pt/guide/harness).

## Onde o Kata para, de propósito

Um framework que tira liberdade precisa ser igualmente disciplinado sobre onde ele
*não* alcança, ou as opiniões viram uma jaula. O Kata traça uma linha dura:

> O Kata é dono da requisição. Infraestrutura e política de produto continuam suas.

Concretamente, o Kata é dono do roteamento tipado, da validação obrigatória de
`input` / `output`, da injeção de dependências, do error envelope e do ciclo de vida
da requisição. Ele **não** entrega uma camada de persistência, um rate limiter, um
exportador de métricas, um carregador de config ou um helper de paginação. Esses são
bring-your-own — não lacunas, mas o limite.

Isso é deliberado. Cada uma dessas preocupações depende da sua infraestrutura ou do
seu produto, e embutir uma escolha te prenderia a um fornecedor ou a um formato
enquanto incharia o core que o verificador tem que manter pequeno e verificável. O
Kata te dá as alavancas no lugar: um slot **singleton** para um client de vida longa,
um slot **scoped** para estado por requisição, e um app Hono puro que você pode
estender com qualquer middleware. Seu banco de dados, limiter e métricas se encaixam
nessas alavancas sem esperar pelo framework.

::: info Bring-your-own é uma feature
Se você procurar por um recurso embutido e não achar nenhum, isso é o design, não uma
omissão. O [cookbook de non-goals](/pt/cookbook/non-goals) mostra o BYO idiomático
para persistência, rate-limiting, métricas, validação de env e paginação — cada um
sobre uma alavanca que você já tem.
:::

## O formato disso

O Kata é o que o NestJS seria se fosse um script em vez de um runtime: o mesmo "há um
único jeito certo", expresso como funções, named exports e schemas Zod em vez de
classes e decorators — e verificado por um sistema de tipos em vez de confiado por
convenção. O nome é a tese. Um *kata* é uma forma praticada: disciplinada, repetível,
correta de primeira.

Convencido das restrições? Vá construir algo.

- [Quickstart](/pt/guide/quickstart) — uma API `/users` totalmente tipada em seis arquivos.
- [Context & DI](/pt/guide/context-di) — o único registry onde toda dependência vive.
- [Rotas & schemas](/pt/guide/routes-schemas) — `defineRoute` e contratos obrigatórios.
- [O harness](/pt/guide/harness) — como o verificador e os hooks mantêm o código correto.
