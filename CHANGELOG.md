# Changelog

## 2026-08-27 — fórmulas KaTeX no Markdown

- orienta fórmulas quantitativas para a sintaxe KaTeX, preservando expressões e variáveis sem usar blocos de código.

## 2026-08-27 — Markdown compatível com o leitor do site

- orienta a reescrita a não gerar tags HTML, inclusive `<br>`, no Markdown final.

## 2026-08-26 — fallback para conteúdo curto

- preserva a fonte quando um conteúdo de até 200 tokens é rejeitado por `thinking_leak`, evitando publicação parcial ou falha de lote.

## 2026-08-25 — migração dos padrões Vertex AI

- substitui os fallbacks internos Gemini 2.5 por `gemini-3.5-flash` e `gemini-3.5-flash-lite`;
- mantém modelos 2.5 apenas quando configurados explicitamente durante a transição;
- documenta a entrada em Extended Lifecycle Access em 20/10/2026.

## 2026-08-21 — compatibilidade do retrofit visual

- exclui as subpastas visual e de saída da varredura recursiva da entrada;
- diferencia no log arquivos sem mapa, já compatíveis e preservados após falha;
- exibe a contagem de pareamentos e a compatibilidade de títulos no preflight;
- cobre em teste o uso de `visual` e `saida` dentro da pasta dos arquivos reescritos.

## 2026-08-21 — retrofit visual incremental

- adiciona `npm run visual:retrofit` para enriquecer arquivos já reescritos sem reescrita integral;
- gera e valida somente recursos visuais ausentes, mantendo o conteúdo original como subsequência exata;
- oferece `--dry-run` sem Vertex e bloqueia associações com títulos incompatíveis antes de chamadas pagas;
- copia byte a byte arquivos sem mapa ou com falha de geração, sem publicação parcial;
- rejeita HTML, protocolos executáveis, títulos, Mermaid inseguro e numerais ausentes na fonte;
- grava relatório auditável com hashes, recursos inseridos e estado de cada arquivo.

## 2026-08-21 — pasta de arquivos visuais por documento

- troca o prompt interativo de guia único pela seleção opcional de uma pasta visual;
- associa cada arquivo visual ao Markdown reescrito pelo prefixo numérico de três dígitos;
- copia sem alterações os arquivos reescritos sem mapa e ignora mapas excedentes com aviso;
- rejeita somente índices duplicados, que não permitem associação segura;
- aceita mapas individuais com cabeçalho `@@ ### **Título**`;
- preserva nomes já terminados em `_reescrito.md`, sem duplicar o sufixo na saída;
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
