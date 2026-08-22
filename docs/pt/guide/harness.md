---
title: Engenharia de harness
description: Como o Kata entrega o verificador, os hooks e o guard contra adulteração de config que fazem os agentes produzirem código correto na primeira tentativa.
---

# Engenharia de harness

Um harness é o conjunto de mecanismos ao redor do modelo — as checagens, os hooks,
a estrutura travada — que pegam um erro no instante em que ele é cometido e dizem ao
modelo como corrigi-lo. A tese do Kata é que esse harness não é ferramenta opcional
parafusada depois. Ele é o produto. `kata init` o entrega em todo projeto.

A regra que governa é **menos liberdade, melhor output**. Um modelo com infinitas
formas de estruturar uma route escreve uma estrutura diferente toda vez, e você
revisa cada uma. Um modelo com exatamente uma estrutura legal escreve essa estrutura,
e uma regra de lint rejeita qualquer outra coisa antes que você a veja. Restrições
não são um imposto sobre o modelo — são o que torna o output dele previsível o
suficiente para confiar. As mesmas restrições ajudam um humano: há um lugar onde
uma coisa pode estar, então há um lugar onde olhar.

Esta página descreve as três camadas de feedback que o Kata conecta, por que elas
são rápidas, e o que `kata init` escreve para ativá-las.

## Três camadas de feedback

O harness roda o mesmo projeto por três loops em três velocidades. Cada camada
falha fechando — uma checagem vermelha bloqueia em vez de avisar.

| Camada | Gatilho | Comando | Velocidade |
|---|---|---|---|
| `PreToolUse` | antes de escrever um arquivo | `kata verify --json` + regras de deny | <100ms |
| `PostToolUse` | depois de escrever um arquivo | `kata verify --json` | <100ms |
| `Stop` | antes de o agente declarar pronto | `pnpm test` | segundos |

As camadas de milissegundos (`PreToolUse` / `PostToolUse`) rodam a cada edição, então
precisam ser rápidas o bastante para nunca interromper o fluxo do modelo. O portão
`Stop` roda a suíte de testes real uma vez, quando o agente acha que terminou:
`kata verify` é um motor de lint, não um runner de testes, então "pronto" é
condicionado aos testes de verdade.

## `kata verify` num hook PostToolUse

Depois que o agente escreve um arquivo, `PostToolUse` roda `kata verify --json`. O
comando lê o projeto, roda as regras determinísticas e imprime um único objeto JSON
no stdout — o formato que um hook `PostToolUse` do Claude Code consome.

Numa execução limpa o output é o objeto vazio, um resultado de hook no-op:

```json
{}
```

Numa violação o hook emite `decision: "block"` e injeta o relatório completo como
`hookSpecificOutput.additionalContext`, de modo que o agente é *instruído a corrigir*
o problema no próximo turno, não apenas exposto a ele:

```json
{
  "decision": "block",
  "reason": "kata verify found 1 violation.",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "kata verify found 1 violation. Fix it before continuing:\n\nERROR: ..."
  }
}
```

::: info Por que `--json` sempre encerra com 0
No modo `--json`, `kata verify` sempre encerra com 0. A decisão viaja dentro do
payload; um exit diferente de zero faria o harness expor o stderr em vez do JSON, e
o agente nunca veria o feedback estruturado.
:::

### ERROR / WHY / FIX / EXAMPLE

Todo problema dentro de `additionalContext` é renderizado com o mesmo template de
quatro partes. Esse é o formato que conduz a uma correção certa em vez de um chute:
ele declara o que está errado, por que a regra existe (com o ADR que a decidiu), a
remediação concreta e um par de código ruim/bom.

```
ERROR: route "createUser" is missing an output schema
  src/modules/users/users.route.ts:12:3  [kata/no-route-without-output-schema]

  WHY: every route declares input and output schemas so the contract is
  verifiable and the RPC client can infer types (ADR-0003).

  FIX: add an `output` schema to the defineRoute call.

  EXAMPLE:
    // Bad:
    defineRoute({ method: 'POST', path: '/users', input: { body: B }, handler })
    // Good:
    defineRoute({ method: 'POST', path: '/users', input: { body: B }, output: UserSchema, handler })
```

O mesmo renderizador alimenta o relatório humano no terminal (`kata verify` sem
`--json`), então o agente e o desenvolvedor leem o texto idêntico.

As regras que `kata verify` impõe, cada uma ancorada no ADR que a justifica:

| Regra | Verifica | ADR |
|---|---|---|
| `kata/no-route-without-output-schema` | todo `defineRoute` declara `output` | ADR-0003 |
| `kata/no-route-without-input-schema` | todo `defineRoute` declara `input` | ADR-0003 |
| `kata/inline-schema` | schemas Zod vivem em `*.schema.ts` | ADR-0005 |
| `kata/context-key-not-registered` | `c.get('key')` é uma chave de contexto registrada | ADR-0004 |
| `kata/scoped-slot-not-provided` | um `c.get` scoped tem um middleware que o fornece *antes dele na cadeia* — no `use:` da rota ou em `createApp({ middlewares })` | ADR-0004 |
| `kata/scoped-read-outside-request` | um `c.get` scoped só é lido dentro de um handler de request | ADR-0004 |
| `kata/middleware-provides-mismatch` | `provides[]` casa com o `c.set` do handler (avisa quando um slot de `c.set` é omitido de `provides`) | ADR-0004 |
| `kata/jwt-auth-provides-slot` | um middleware `jwtAuth({ slot })` declara `provides: [slot]` | ADR-0013 |
| `kata/no-adhoc-error-shape` | erros usam `c.error(...)`, não `c.json({ error }, 4xx/5xx)` inline | ADR-0008 |
| `kata/no-raw-boundary-cast` | um cast bruto `as unknown`/`as never` de fronteira carrega um marcador `// kata-allow: hono-boundary` | ADR-0019 |
| `kata/schema-file-naming` | arquivos de um módulo são nomeados `<domain>.{route,service,schema}.ts` | ADR-0018 |
| `kata/no-decorator` | nenhuma sintaxe `@decorator` sob `src/` | ADR-0002 |
| `kata/no-class` | nenhuma declaração `class` sob `src/` | ADR-0002 |

Veja [Bootstrap CLI](/pt/guide/cli) para a superfície completa de comandos, incluindo
`kata verify --watch` para um loop de re-checagem no terminal.

## Quando uma regra não consegue provar uma checagem

Toda regra lê código-fonte, nunca tipos ou valores de runtime. Algumas expressões
são portanto ilegíveis para ela — um middleware montado em runtime, um importado
de um pacote cujo fonte ela não enxerga, um `...spread` que pode contribuir com
qualquer coisa. Diante de uma dessas, a regra tem três opções, e só uma é honesta:

1. reprovar mesmo assim → falsos positivos, que te treinam a ignorar a ferramenta;
2. pular em silêncio → um check verde que afirma algo que ninguém provou;
3. **dizer o que não conseguiu checar.**

O Kata escolhe a terceira. O caso não checado é reportado como uma **supressão**:
a regra, o motivo, a localização exata e quantas checagens ela engoliu.

```
✓ kata verify: no problems found (13 files checked)

⚠ 1 check suppressed — a rule could not prove its property here:
  kata/scoped-slot-not-provided: suppressed for 3 checks — could not resolve `authFactory()` in createApp({ middlewares })
    src/app.ts:17:18

A suppressed rule is not a passing rule. Re-run with --strict-coverage to fail on these.
```

Supressões também viajam no payload `--json`, num array `suppressions` e no
contexto injetado, então o agente enxerga a lacuna em vez de ler um relatório
limpo. Sozinhas elas não bloqueiam — o código pode estar perfeitamente correto —
mas `kata verify --strict-coverage` sai com código diferente de zero em qualquer
uma delas. O `lefthook.yml` gerado usa essa flag, então uma cadeia que se torna
inverificável reprova o commit em vez de reduzir a cobertura silenciosamente.

Fechar uma supressão significa tornar a expressão legível:

- **Um middleware de um pacote npm.** O pacote publica um manifesto
  `provides.json` descrevendo o que cada middleware exportado fornece e lê; o
  `@katajs-framework/core` gera o seu no build, que é por que `cors()`, `secureHeaders()` e
  `bodyLimit()` resolvem. Autores de middleware de terceiros podem publicar o
  mesmo arquivo.
- **Uma factory local.** O `kata verify` segue a chamada até o `return`, então
  `requireRole('admin')` resolve desde que a factory retorne um
  `defineMiddleware({ ... })` (ou um literal de middleware) que ele consiga ler.
- **Um spread ou uma lista computada.** Escreva o array literalmente.
  `use: [a, b]` é checável; `use: [...preset]` não é.

## Por que o harness é rápido

Um linter que precisa de um type-checker ou de um bundler para responder a uma
pergunta não pode rodar a cada tecla. `kata verify` responde em menos de 100ms porque
as três invariantes do Kata tornam toda checagem uma pergunta local e sintática — sem
inferência de tipos, sem grafo entre arquivos para resolver em tempo de lint.

1. **DI estático.** Toda dependência é declarada em um único `defineContext({...})`.
   Verificar que `c.get('key')` é legal é um teste de pertinência a conjunto contra as
   chaves parseadas de `src/context.ts` — não um percurso do grafo de tipos.
2. **Schemas obrigatórios.** Toda route declara `input` e `output`. Checar que um
   schema está presente é ler o literal de objeto do `defineRoute`, não avaliá-lo.
3. **Layout de pastas travado.**
   `src/modules/<domain>/<domain>.{route,service,schema,hurl,test}.ts` significa que toda
   route, schema e teste é encontrável por glob. O verificador sabe onde olhar sem
   resolver imports.

Como as regras são funções puras sobre arquivos parseados, elas também são
trivialmente testáveis em unidade e carregam um viés de zero falso-positivo: quando o
registry não pode ser determinado, as regras dependentes viram no-op em vez de chutar.

## Não-objetivos: o que o `kata verify` deliberadamente não checa

Nem toda propriedade que vale a pena checar vira uma regra. Uma surgiu em
revisão ([issue #251](https://github.com/VicenzoMF/kata/issues/251)): um módulo
sob `src/modules/<domain>/` cujas routes nunca são passadas para nenhum
`createApp({ modules })` é superfície morta — toda route dentro dele ainda
passa em `kata/no-route-without-output-schema` e afins individualmente, porque
essas regras escaneiam arquivos `*.route.ts` diretamente (veja a tabela acima)
e nunca perguntam se o módulo chegou a algum app. Um "módulo órfão" deveria
virar sua própria regra?

**Decisão: um não-objetivo documentado, não uma regra.**

Toda regra acima prova uma *presença* — um `c.get('key')` que existe e não
está registrado, uma `class` que existe, um `z.object(...)` inline que existe.
O caso ilegível (um spread, um valor computado em runtime) é seguro de pular,
porque pular só abre mão da checagem daquela expressão específica; a
invariante "sem grafo entre arquivos para resolver em tempo de lint" acima se
sustenta porque a resposta de cada regra permanece local ao que ela consegue
ler.

Uma regra de módulo órfão precisaria provar uma *ausência*: que nenhum
`createApp({ modules })` em lugar nenhum do projeto inclui esse módulo. Essa
não é uma pergunta local:

- Um projeto pode ter mais de um `createApp` — servers separados, um worker,
  apps de exemplo cada um conectando um subconjunto diferente. "Alcançável"
  precisa ser uma união sobre todo call site que o projeto tem, não um só.
- `modules:` é exatamente a forma que o `kata verify` já trata como
  irresolvível quando aparece em `middlewares:` / `use:` — montada a partir de
  uma lista compartilhada, filtrada por uma flag de env, montada num harness de
  teste. Toda outra regra responde a uma expressão irresolvível com "pular" —
  e isso custa um call site não checado. Aqui custaria a única evidência que
  livraria o módulo de ser órfão: no instante em que um projeto usa uma
  indireção, um módulo corretamente conectado passaria a ler como órfão. O modo
  de falha que essa regra existiria para evitar é exatamente o que ela
  introduziria.
- Nada manda fazer isso. `createApp({ modules })` aceitar um subconjunto
  escolhido a dedo é a forma de trabalho normal — um módulo scaffoldado antes
  de ser conectado, um construído para um deployment que o app atual não é —
  então não há ADR para ancorar uma regra, diferente de toda regra na tabela
  acima. O epic do conjunto de regras
  ([#164](https://github.com/VicenzoMF/kata/issues/164)) se limitou a impor
  mecanicamente ADRs já existentes e já entregou todo o seu escopo (6/6
  sub-issues); detecção de módulo órfão nunca fez parte dele.

Alcançabilidade através de um número arbitrário de entry points é uma pergunta
de programa inteiro — do tipo que uma ferramenta dedicada de dead-code
(`ts-prune`, `knip`) responde com informação de tipo completa, não um passe
sintático de menos de 100ms sobre um arquivo por vez. Se isso um dia valer a
pena ter, é uma ferramenta separada conectada no CI, não uma regra do
`kata verify`.

## O guard contra adulteração de config

A literatura de engenharia de harness nomeia dois reflexos que um modelo busca no
instante em que uma checagem fica vermelha — ambos transformam um sinal de falha em
verde sem tocar no código que falhou:

1. **Burlar o portão de commit** — `git commit --no-verify` (ou `-n`),
   `git push --no-verify`, um prefixo de env `SKIP=<hook>`.
2. **Editar a própria regra** — apagar uma regra do Oxlint, afrouxar `tsconfig.json`,
   esvaziar um workflow de CI, reescrever um script de hook. A checagem passa porque a
   checagem sumiu.

O [ADR-0010](/adr/0010-ban-no-verify-and-config-tampering) bane ambos, mecanicamente
e de forma idêntica em todo harness. Esta é uma única fonte de verdade: os comandos
banidos e o conjunto de arquivos protegidos são declarados uma vez e reproduzidos em
todo projeto que `kata init` scaffolda.

### Sem `--no-verify`

Os bypasses de verificação são negados de imediato. Num projeto gerado eles vivem
em `.claude/settings.json` sob `permissions.deny`:

```json
{
  "permissions": {
    "deny": [
      "Bash(git commit *--no-verify*)",
      "Bash(git commit *-n *)",
      "Bash(git push *--no-verify*)",
      "Bash(SKIP=*)"
    ]
  }
}
```

O Codex não tem um slot `permissions.deny`, então o hook `PreToolUse` dele impõe os
mesmos bans de comando — paridade por construção, não por cópia.

### O conjunto de configs protegidas

O mesmo ADR protege as configs de lint / format / build / framework e os próprios
arquivos do harness contra escritas do agente:

```
tsconfig.json   tsconfig.*.json   biome.json   .oxlintrc*   lefthook.yml
kata.config.ts  pnpm-lock.yaml    pnpm-workspace.yaml       .github/workflows/**
.claude/settings.json             .codex/hooks.json
```

No Claude Code essas viram regras `permissions.deny` por ferramenta (uma para cada um de
`Edit`, `Write`, `MultiEdit`), de modo que um projeto recém-scaffoldado fica protegido
desde a primeira sessão — antes mesmo de qualquer conjunto de regras do `kata verify`
ser construído. O hook `PreToolUse` é a segunda camada: ele carrega a explicação
ancorada no ADR e é onde o Codex (sem slot de deny) impõe o conjunto idêntico.

::: warning Humanos ainda editam esses arquivos
O viés é *sempre bloquear no fluxo do agente*. Não há um discriminador humano/agente
confiável dentro do hook, e o Kata não tenta construir um. Quando você precisar mudar
uma config protegida, faça isso de um shell que não seja de agente.
:::

::: tip Autoaplicado primeiro
O Kata aplica esse harness ao próprio repositório. O [ADR-0007](/adr/0007-self-apply-harness-before-feature-work)
fez um marco de harness autoaplicado bloquear todo trabalho de feature: o framework é
seu próprio primeiro usuário, então o harness que `kata init` entrega é o mesmo que
construiu o Kata.
:::

## O que `kata init` conecta

`kata init` escreve o harness num projeto. Ele é idempotente — um arquivo existente
é deixado intacto a menos que você passe `--force`.

```bash
kata init
```

Ele escreve quatro arquivos:

```
.claude/settings.json    Hooks do Claude Code + bans de adulteração de config
.codex/hooks.json        Hooks do Codex → kata verify --json
AGENTS.md                Instruções canônicas de agente (Codex + Claude)
CLAUDE.md                Entrypoint do Claude → importa AGENTS.md
```

O `.claude/settings.json` gerado carrega as listas `permissions.deny` acima mais o
mapa de hooks de três eventos: `PreToolUse` e `PostToolUse` casados em
`Write|Edit|MultiEdit` rodam `kata verify --json`; `Stop` roda `pnpm test` com um
timeout de 180 segundos.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "kata verify --json" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "kata verify --json" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "pnpm test", "timeout": 180 }] }
    ]
  }
}
```

`.codex/hooks.json` é o mesmo mapa de hooks com uma diferença: o matcher é
`Bash|apply_patch`. O Codex casa por nomes de ferramentas e não tem ferramentas
`Write`/`Edit`/`MultiEdit`, então as escritas de arquivo são detectadas a partir da
ferramenta `Bash`/`apply_patch`. Os comandos, os eventos e o timeout do `Stop` são
idênticos — essa paridade é o ponto.

Por padrão, `kata init` faz o scaffold de um app completo e executável em cima
destes arquivos do harness; `--minimal` escreve só o harness. Veja
[Bootstrap CLI](/pt/guide/cli) para cada flag.

## Veja também

- [Bootstrap CLI](/pt/guide/cli) — a superfície completa de comandos `kata`.
- [ADR-0007](/adr/0007-self-apply-harness-before-feature-work) — autoaplicar o harness antes do trabalho de feature.
- [ADR-0010](/adr/0010-ban-no-verify-and-config-tampering) — banir `--no-verify` e adulteração de config.
