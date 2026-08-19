# Changelog

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
