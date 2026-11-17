# AGENTS.md — ParaJaca

Instruções obrigatórias para qualquer agente de código neste repositório.

## 1. Fontes de instrução (ler SEMPRE)

Em TODA interação, antes de responder ou alterar qualquer coisa, pesquise nos dois arquivos da raiz:

1. `REGRAS_DE_CODIGO.txt` — o **contrato de código**: COMO escrever (stack, nomes, unidades, assinaturas, fórmulas, shaders, erros, testes, proibições).
2. `FASES_DE_IMPLEMENTACAO.txt` — O QUE fazer e EM QUE ORDEM (fases, etapas, aceite, portões).

Procedimento mínimo em cada interação:

- Localize no `FASES_DE_IMPLEMENTACAO.txt` a primeira etapa com `[ ]` (pendente). Essa é a etapa atual.
- Leia a etapa atual inteira e TODAS as seções `R§` que ela cita em `REGRAS_DE_CODIGO.txt`.
- Busque (grep) nos dois arquivos os nomes das funções, constantes e arquivos que você vai tocar.

Precedência em caso de conflito:
- Sobre **como** codificar → vale `REGRAS_DE_CODIGO.txt`.
- Sobre **o que / quando** → vale `FASES_DE_IMPLEMENTACAO.txt`.
- Pedido explícito do usuário na conversa prevalece sobre ambos, mas avise quando o pedido contrariar uma regra.

`BLUEPRINT.md` é o documento-fonte (o porquê das decisões). Consulte-o só para entender a intenção de uma regra ou etapa. Ele não substitui os dois arquivos acima: se o blueprint parecer divergir deles, siga os dois arquivos e avise o usuário.

## 2. Execução das fases (seguir à risca)

1. Uma etapa por vez, na ordem exata. Não pule, não junte, não adiante etapas.
2. Altere SOMENTE os arquivos listados em "Arquivos" da etapa atual.
3. Execute os passos de "Fazer" na ordem; respeite "Não fazer".
4. Ao fim da etapa:
   - rode `npm run check` (typecheck + testes) e corrija até passar;
   - marque a etapa como `[x]` no `FASES_DE_IMPLEMENTACAO.txt` (única edição permitida nesse arquivo);
   - relate ao usuário: o que foi feito, arquivos alterados, saída do check e o que exige validação manual.
5. Etapas **PORTÃO**: pare e aguarde aprovação explícita do usuário.
6. Etapas **USUÁRIO**: dependem de imagens ou medições do usuário. Peça. Nunca invente imagens, medições, resultados ou aprovações.
7. Se o aceite falhar após 3 tentativas de correção: pare e relate o erro exato.
8. Não comece a etapa seguinte na mesma resposta sem o usuário pedir.

## 3. Como escrever o código (resumo; o detalhe está no contrato)

- Copie **literalmente** nomes de arquivos, funções, constantes, typedefs, eventos, códigos de erro, fórmulas e trechos GLSL do `REGRAS_DE_CODIGO.txt`. Não renomeie, não "melhore", não generalize.
- JavaScript ES modules + JSDoc; `npm run typecheck` com 0 erros. Sem `any`, sem `@ts-ignore`.
- Código e comentários em inglês; textos do estúdio em pt-BR só em `src/studio/strings.js`.
- Sufixos de unidade obrigatórios: `Css`, `Comp`, `Render`, `Tex`, `Ref`, `Ms`, `Sec`, `Bytes`. Toda conversão de unidade em linha própria.
- Respeite a tabela de imports (R§3). Só `src/core/render/**` chama `gl.*`.
- Caminho quente (loop de quadros) sem alocação e sem leituras síncronas da GPU (R§11).
- Toda carga assíncrona com `AbortSignal` e token de geração (R§9).
- Nenhum erro engolido (R§8).
- Valores marcados `// calibrate` só mudam com valor informado/aprovado pelo usuário.
- Na dúvida: a solução mais simples que respeite o contrato. Se a dúvida afetar formato de dados, API, fórmula ou desempenho, pare e pergunte.

## 4. Proibido

- Criar arquivos fora da lista R§2.1/R§2.2, ou arquivos de plano, notas, resumo ou TODO.
- Adicionar dependências não listadas em R§1.
- Alterar `BLUEPRINT.md`, `REGRAS_DE_CODIGO.txt` ou o conteúdo das etapas do `FASES_DE_IMPLEMENTACAO.txt` (só o status `[ ]`→`[x]`) sem pedido do usuário.
- Itens da lista R§20.

## 5. Comunicação

- Responda ao usuário em pt-BR, de forma direta.
- Ao relatar, distinga o que foi verificado (check, testes) do que depende de teste visual/medição do usuário.
- Ao fornecer comando para o usuário rodar no PowerShell, use uma única linha.
