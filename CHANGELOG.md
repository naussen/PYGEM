# Changelog

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
