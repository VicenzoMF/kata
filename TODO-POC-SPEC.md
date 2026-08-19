# Kata — Especificação: Todo List (Prova de Conceito / Teste de Desenvolvimento por IA)

> **Status:** Especificação — nada abaixo foi implementado ainda.
> **Data:** 2026-08-19
> **Objetivo:** um projeto de teste pequeno e realista ("todo list da vida")
> usado para avaliar se um agente de IA, tendo acesso **somente** à
> documentação publicada do framework (via uma ferramenta de busca dedicada
> às docs, ainda a ser construída), consegue implementar corretamente uma
> aplicação idiomática — e, por consequência, se a documentação em si está
> completa e correta.

---

## 1. Regra do experimento

Este documento é intencionalmente **agnóstico de implementação**: ele não
cita nenhum nome de função, comando de CLI, convenção de nome de arquivo,
número de decisão de arquitetura, ou qualquer outro detalhe específico do
framework. Tudo isso precisa ser descoberto pesquisando a documentação — essa
é a própria variável sendo testada.

Duas coisas são avaliadas ao mesmo tempo:

1. **A implementação em si** — o agente consegue, só com os requisitos
   abaixo e a busca nas docs, chegar a uma aplicação correta e idiomática?
2. **A documentação** — todo ponto de atrito, ambiguidade ou lacuna que o
   agente encontrar ao tentar satisfazer um requisito é sinal de uma
   deficiência na doc, não necessariamente na implementação.

Se, ao revisar este arquivo no futuro, algo aqui vazar conhecimento
específico do framework (um termo, um nome de API, um padrão de arquivo),
isso deve ser reescrito em termos genéricos antes de usar a spec.

## 2. Domínio: Todo List

Entidade única: um todo pertence a um usuário autenticado e tem título e
estado de conclusão. Um usuário só enxerga e só edita os próprios todos.

Operações exigidas (nível de requisito, não de implementação):

- Listar os todos do usuário autenticado, com filtro opcional por concluído/não concluído.
- Buscar um todo específico por id — se não existir, ou existir mas pertencer
  a outro usuário, o comportamento observável de fora deve ser idêntico (não
  pode dar pra distinguir "não existe" de "não é seu").
- Criar um todo a partir de um título.
- Atualizar título e/ou estado de conclusão de um todo existente.
- Remover um todo.
- Obter um token apresentando uma identidade (um login simplificado, sem
  senha real) — chamadas subsequentes só são tratadas como autenticadas se
  apresentarem esse token.
- Um endpoint de verificação de disponibilidade (liveness), sem autenticação.

## 3. Requisitos não funcionais

Cada item é uma propriedade que o sistema final precisa satisfazer. Nenhum
prescreve o mecanismo — descobrir o mecanismo correto é parte do que está
sendo testado.

- Toda entrada e toda saída de cada operação deve ser validada contra uma
  definição de schema explícita — nenhuma validação ad-hoc dentro da lógica
  de negócio.
- Autenticação deve ser via token assinado apresentado pelo chamador — não
  sessão guardada em memória, não um cabeçalho de identidade não verificado.
- Estado associado a uma requisição individual (ex.: identidade do usuário
  autenticado nela) deve ficar isolado por requisição — não pode vazar nem
  ser compartilhado entre chamadas concorrentes.
- Toda resposta de erro (falta de autenticação, token inválido, recurso não
  encontrado, corpo de requisição inválido, falha interna inesperada) deve
  seguir um único formato consistente em toda a aplicação.
- Proteções de borda (CORS, cabeçalhos de segurança, limite de tamanho do
  corpo da requisição) devem se aplicar à aplicação inteira, configuradas em
  um único lugar — não repetidas operação por operação.
- Requisições de pre-flight CORS devem ser respondidas corretamente.
- O processo deve encerrar de forma graciosa ao receber um sinal de término:
  parar de aceitar conexões novas, deixar as requisições em andamento
  terminarem, só então finalizar — sem cortar clientes no meio de uma
  resposta.
- Cada requisição deve ser registrada em log com um identificador de
  correlação, e esse identificador deve ser devolvido ao chamador na
  resposta.
- Deve existir um cliente que consome esta API com tipagem ponta-a-ponta —
  os tipos de requisição e resposta no lado do cliente devem ser inferidos
  automaticamente a partir das mesmas definições que o servidor usa para
  validar, sem geração de código e sem redefinir os tipos manualmente no
  cliente.
- O projeto deve ser verificável por uma ferramenta de análise estática
  própria do framework capaz de apontar desvios das convenções esperadas —
  essa ferramenta deve rodar sem nenhum achado sobre o projeto final.
- A estrutura inicial do projeto (pastas, arquivos de configuração) deve ser
  gerada por uma ferramenta própria do framework, não escrita à mão do zero.

## 4. Critérios de aceite

- Existe uma suíte de testes automatizados cobrindo a lógica de domínio
  (criação, listagem, atualização, remoção, isolamento por dono).
- Existe uma suíte de testes ponta-a-ponta sobre HTTP real cobrindo: o fluxo
  de CRUD completo; ausência de token; token inválido; recurso não encontrado
  (incluindo o caso de pertencer a outro usuário); corpo de requisição
  inválido; a resposta a uma requisição de pre-flight CORS; um caminho que
  força um erro interno; e o eco do identificador de correlação.
- Existe uma verificação em tempo de compilação que falha caso os tipos
  inferidos pelo cliente divirjam dos schemas do servidor.
- Existe um teste de execução real amarrando o cliente tipado a uma instância
  viva do servidor (não só a checagem em tempo de compilação).
- A ferramenta de análise estática do framework roda sem achados sobre o
  projeto.

## 5. Fora de escopo

Persistência real em banco de dados, limitação de taxa de requisições,
métricas, gestão de variáveis de ambiente e paginação não fazem parte deste
teste, independente do que os requisitos acima cubram.

## 6. Notas do experimento (não são requisito de implementação)

- Onde o projeto vai viver dentro do repositório (pacote do workspace vs.
  consumidor externo de um pacote empacotado) e se ele entra no pipeline de
  integração contínua são decisões de infraestrutura do experimento em si,
  não requisitos da aplicação — ficam em aberto até a implementação.
- Este arquivo é reutilizável: a cada mudança relevante no framework, a mesma
  spec pode ser usada de novo para revalidar tanto a implementação quanto a
  documentação.
