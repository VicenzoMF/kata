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
| `kata/scoped-slot-not-provided` | um `c.get` scoped tem um middleware que o fornece | ADR-0004 |
| `kata/middleware-provides-mismatch` | `provides[]` casa com o `c.set` do handler | ADR-0004 |
| `kata/context-key-not-registered` | `c.get('key')` é uma chave de contexto registrada | ADR-0004 |

Veja [Bootstrap CLI](/pt/guide/cli) para a superfície completa de comandos, incluindo
`kata verify --watch` para um loop de re-checagem no terminal.

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
