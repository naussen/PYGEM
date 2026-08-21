# Changelog

## 2026-08-21 — pasta de arquivos visuais por documento

- troca o prompt interativo de guia único pela seleção opcional de uma pasta visual;
- associa cada arquivo visual ao Markdown reescrito pelo prefixo numérico de três dígitos;
- rejeita índices visuais ausentes, duplicados e arquivos reescritos sem visual correspondente;
- mantém `--visual-guide` e `--visual-plan` para compatibilidade com automações existentes;
- persiste os planos compilados individualmente em `_visual-plans` na pasta de saída.

## 2026-08-20 — guia visual opcional no fluxo interativo

- adiciona pergunta opcional para selecionar um guia visual Markdown ao iniciar o PYGEM;
- solicita a disciplina somente quando o guia é informado e preserva o fluxo anterior com Enter;
- impede que o próprio guia seja reescrito quando estiver dentro do diretório de entrada;
- documenta um exemplo de tópico com tabela comparativa e caixa de atenção.

## 2026-08-19 — preflight dos pilotos visuais

- adiciona preflight restrito aos pilotos 010, 022 e 023;
- registra hashes, modelo, seed e diretórios sem chamar Vertex AI nem importar resultados;
- exige diretório de saída novo e preserva fontes originais.
- adiciona CLI de preflight com parâmetros explícitos para fonte, plano e saída.
- executa os pilotos reais 010, 022 e 023 em diretório novo, com auditoria visual aprovada e sem importação.

## 2026-08-19 — fixtures visuais

- adiciona fixtures artificiais dos pilotos 010, 022 e 023;
- cobre validação de manifesto, variantes determinísticas, recursos ausentes,
  seção-alvo incorreta e Mermaid inválido sem chamadas ao Vertex AI.

## 2026-08-19

- adiciona schemas v1 do plano e do manifesto visual;
- compila relatórios Markdown em planos funcionais sem chamada ao Vertex AI;
- valida hashes, slugs, requisitos, cardinalidade e campos desconhecidos;
- permite que um manifesto de arquivo represente vários tópicos agrupados;
- grava manifestos e planos JSON de forma atômica;
- adiciona fixtures e testes offline para o novo contrato.
- integra guia Markdown ou plano JSON ao processamento principal do PYGEM;
- seleciona tópicos visuais por índice explícito ou título, tolerando fragmentação de OCR;
- envia ao modelo somente os requisitos visuais pertinentes ao arquivo atual;
- invalida checkpoints e reaproveitamentos quando o contrato visual muda;
- persiste o plano normalizado como `_visual-plan.json` no diretório de saída.
- seleciona variantes visuais por SHA-256 da semente, tópico, recurso e papel semântico;
- impede variantes incompatíveis com a função didática antes da geração;
- orienta estruturas distintas para tabelas, Mermaid e realces sem copiar a identidade da referência;
- inclui variantes determinísticas nos planos produzidos pelo compilador de linha de comando.
- detecta blocos de tabela, Mermaid, realce e mnemônico na saída Markdown;
- valida quantidades mínimas/máximas, seção-alvo e sintaxe Mermaid por tópico;
- rejeita conformidade visual inválida antes da publicação sequencial ou paralela.
