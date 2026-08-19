# Plano de implementação — manifesto visual PYGEM → LEIAUT

## 1. Objetivo

Implementar um fluxo no qual o usuário forneça, para cada disciplina:

1. os arquivos Markdown usados como fonte de conteúdo; e
2. um relatório descritivo dos recursos visuais e pedagógicos existentes na referência.

O PYGEM deve converter o relatório em requisitos funcionais por tópico, reescrever o conteúdo e aplicar os mesmos tipos de ferramenta didática relevantes, como tabela, diagrama e realce, sem reproduzir a expressão visual, a redação, a geometria ou a sequência editorial da referência.

O LEIAUT deve transportar essas decisões para o JSON final, verificar o manifesto e impedir a publicação quando um recurso obrigatório desaparecer.

## 2. Resultado arquitetural obrigatório

```text
Markdown de conteúdo ───────┐
                            ├─> PYGEM ─> Markdown reescrito
Relatório visual descritivo ┘              + manifesto visual
                                                   │
                                                   v
                                               LEIAUT
                                                   │
                                                   v
                                  JSON final + relatório de validação
```

Responsabilidades:

- PYGEM: análise editorial, seleção determinística de variantes, geração dos recursos e criação do manifesto de execução.
- LEIAUT: estruturação do JSON, preservação dos recursos e validação anterior à publicação.
- Site: renderização do contrato atual. Não alterar o site na primeira versão.

O relatório visual bruto não deve ser anexado ao prompt de reescrita. Primeiro ele deve ser reduzido a um plano funcional validado, evitando que detalhes expressivos da referência induzam reprodução acidental.

## 3. Restrições não negociáveis

- Preservar o contrato final atual: `topic_id`, `topic_title`, `discipline` e `sections`.
- Preservar, em cada seção: `content_markdown`, `callouts`, `mnemonics`, `flashcards` e `mermaid_mindmap`.
- Não adicionar dependência quando validação e hashing puderem ser feitos com Node.js padrão.
- Não realizar chamadas reais ao Vertex AI em testes automatizados.
- Não copiar cores, marcas, autores, identidade, imagens, geometria ou redação não normativa da referência.
- Não alterar fatos, prazos, fórmulas, exceções, normas ou relações lógicas para obter diversidade visual.
- Não publicar JSON parcial nem JSON que viole requisito visual obrigatório.
- Manter Mermaid client-only no site e compatível com a política de segurança existente.
- Mnemônicos existentes exigem decisão editorial explícita: preservar um mnemônico raro pode manter vínculo reconhecível com a fonte.
- Não prometer impossibilidade absoluta de associação. O critério implementável é redução de similaridade expressiva com preservação factual.

## 4. Convenção de entrada e saída

### 4.1 Entrada

Adicionar ao PYGEM:

```powershell
npm.cmd start -- --visual-guide "C:\caminho\auditoria.visual.md"
```

Também aceitar:

```env
PYGEM_VISUAL_GUIDE=C:\caminho\auditoria.visual.md
```

Precedência:

1. `--visual-guide`;
2. `PYGEM_VISUAL_GUIDE`;
3. execução sem guia, mantendo compatibilidade com o fluxo atual.

Aceitar também um plano previamente compilado:

```powershell
npm.cmd start -- --visual-plan "C:\caminho\auditoria.visual-plan.json"
```

Não pesquisar relatórios automaticamente dentro da pasta de conteúdo. Isso evita processar o guia como se fosse matéria.

### 4.2 Saída do PYGEM

Para cada arquivo:

```text
010_Auditoria_reescrito.md
010_Auditoria_reescrito.visual-manifest.json
```

Para o lote:

```text
_visual-plan.json
_pygem.manifest.json
```

O `_visual-plan.json` é interno ao pipeline e não deve ser importado pelo site.

### 4.3 Entrada e saída do LEIAUT

O LEIAUT deve procurar o manifesto irmão pelo nome do Markdown. Deve também aceitar caminho explícito:

```powershell
npm.cmd run leiaut -- arquivo_reescrito.md --visual-manifest arquivo_reescrito.visual-manifest.json
```

Saídas:

```text
arquivo_reescrito_processado.json
arquivo_reescrito_processado.visual-validation.json
```

O JSON público não recebe campos novos.

## 5. Schema do plano visual

Criar `src/visual/schemas/visual-plan.schema.json` no PYGEM, com `schema_version: 1`.

Estrutura mínima:

```json
{
  "schema_version": 1,
  "discipline": "Auditoria",
  "guide_id": "auditoria-visual-v1",
  "guide_sha256": "sha256-em-hexadecimal",
  "diversification_seed": "auditoria-v1",
  "topics": [
    {
      "source_index": "022",
      "canonical_title": "Relatório de auditoria",
      "topic_slug": "relatorio-de-auditoria-nbc-ta-700-701-705-e-706",
      "requirements": [
        {
          "resource": "mermaid",
          "semantic_role": "decision_flow",
          "required": true,
          "minimum": 1,
          "maximum": 1,
          "target_section": "Tipos de opinião/relatório",
          "variant_family": "decision-first"
        },
        {
          "resource": "table",
          "semantic_role": "comparison",
          "required": true,
          "minimum": 1,
          "maximum": 1,
          "target_section": "Estrutura básica do relatório de auditoria",
          "variant_family": "entities-as-rows"
        },
        {
          "resource": "highlight",
          "semantic_role": "critical_order",
          "required": true,
          "minimum": 1,
          "maximum": 2,
          "target_section": "Estrutura básica do relatório de auditoria",
          "variant_family": "summary-after"
        }
      ]
    }
  ]
}
```

Enums iniciais:

- `resource`: `table`, `mermaid`, `highlight`, `mnemonic`.
- `semantic_role`: `comparison`, `classification`, `timeline`, `decision_flow`, `process_flow`, `hierarchy`, `rule`, `exception`, `critical_order`, `memory_key`.
- `variant_family`: validada conforme recurso e papel semântico.

O validador deve rejeitar:

- versão desconhecida;
- tópico sem seletor estável;
- recurso ou papel desconhecido;
- `minimum` negativo ou superior a `maximum`;
- recurso obrigatório com `minimum` igual a zero;
- `topic_slug` fora de `[a-z0-9]+(?:-[a-z0-9]+)*`;
- dois tópicos com o mesmo `topic_slug`;
- hash ausente ou incompatível quando o plano tiver sido compilado de um relatório.

## 6. Schema do manifesto de execução

Criar `src/visual/schemas/visual-manifest.schema.json`.

Campos mínimos:

```json
{
  "schema_version": 1,
  "status": "complete",
  "source_file": "022_Auditoria.md",
  "output_file": "022_Auditoria_reescrito.md",
  "source_sha256": "...",
  "output_sha256": "...",
  "visual_plan_sha256": "...",
  "topic_slug": "relatorio-de-auditoria-nbc-ta-700-701-705-e-706",
  "selected_variants": [],
  "requirements": [],
  "observed_resources": [],
  "violations": []
}
```

Estados permitidos: `complete`, `incomplete`, `invalid`.

Não gravar caminho absoluto, conteúdo integral, credencial, prompt ou resposta bruta do modelo.

## 7. Pacotes de implementação

### Pacote 1 — Schema e convenção

Arquivos previstos no PYGEM:

- `src/visual/schemas/visual-plan.schema.json`;
- `src/visual/schemas/visual-manifest.schema.json`;
- `src/visual/visualPlanValidator.js`;
- `src/visual/visualManifest.js`;
- `src/visual/visualGuideCompiler.js`;
- `README.md`;
- `.env.example`;
- `test-visual-plan.js`;
- `CHANGELOG.md`.

Implementar validação com JavaScript padrão. O JSON Schema serve como contrato documentado; não adicionar Ajv somente para esta etapa.

O compilador deve:

1. calcular SHA-256 do relatório;
2. identificar títulos numerados e nomes canônicos;
3. converter descrições em requisitos funcionais estruturados;
4. validar integralmente o plano antes de salvá-lo;
5. permitir reutilização quando hash, schema e versão do compilador coincidirem.

Se a compilação usar Vertex AI, usar Structured Outputs e nunca aceitar plano parcial. Testes devem injetar resposta simulada.

Critério de aceite: relatório válido produz plano válido e relatório ambíguo falha com tópico e campo identificados.

### Pacote 2 — Suporte ao guia no PYGEM

Arquivos previstos:

- `src/app-md.js`;
- `src/services/promptServiceMd.js`;
- `src/services/geminiService.js`;
- `src/services/rewriteCheckpointService.js`;
- testes correspondentes.

Implementar:

- parse de `--visual-guide` e `--visual-plan`;
- seleção do requisito pelo prefixo numérico, título canônico e slug;
- envio ao modelo somente do requisito funcional do tópico atual;
- inclusão do hash do plano no hash do checkpoint;
- invalidação de checkpoint quando plano, variante ou schema mudar;
- compatibilidade total quando nenhum guia for informado.

Critério de aceite: dois tópicos processados no mesmo lote recebem apenas seus próprios requisitos.

### Pacote 3 — Variantes determinísticas

Criar `src/visual/visualVariants.js`.

Seleção:

```text
SHA-256(diversification_seed + topic_slug + resource + semantic_role)
    → índice estável na lista de variantes compatíveis
```

Famílias iniciais:

Tabela:

- `criteria-as-rows`;
- `entities-as-rows`;
- `split-comparison`;
- `rule-consequence`.

Mermaid:

- `linear-stages` para processo;
- `decision-first` para decisão;
- `root-branches` para hierarquia;
- `phase-groups` para linha do tempo.

Realce:

- `warning-before`;
- `summary-after`;
- `keyword-rule`;
- `exception-block`.

Regras:

- nunca selecionar variante incompatível com o papel semântico;
- nunca alterar causalidade, ordem normativa ou condição lógica;
- não reproduzir simultaneamente cabeçalhos, ordem de linhas e composição descrita na referência;
- uma mesma semente deve gerar a mesma escolha em reexecuções.

O PYGEM continua gerando o conteúdo da ferramenta; a seleção da família e suas restrições estruturais são determinísticas.

### Pacote 4 — Validação obrigatória no PYGEM

Criar `src/visual/visualResourceDetector.js` e `src/visual/visualComplianceValidator.js`.

Detectar no Markdown:

- tabelas GFM válidas, contando blocos e não apenas linhas;
- cercas Mermaid e o tipo do grafo;
- blockquotes/admonitions usados como realce;
- mnemônicos explicitamente presentes.

Validar por tópico e seção:

- quantidade mínima e máxima;
- tipo e papel esperados;
- presença na seção de destino;
- sintaxe Mermaid pela validação de segurança já existente;
- ausência de duplicação do mesmo fato em vários recursos.

Recurso obrigatório ausente deve rejeitar a saída e alimentar a recuperação normal do PYGEM. Após esgotar as tentativas, o arquivo fica `incomplete`; não publicar como sucesso.

### Pacote 5 — Consumo do manifesto pelo LEIAUT

Arquivos previstos no LEIAUT:

- `src/app-leiaut.js`;
- `src/visual/visualManifestReader.js`;
- `src/visual/visualComplianceValidator.js`;
- `test-leiaut.js`;
- `test-leiaut-quality.js`;
- `README.md`;
- `CHANGELOG.md`.

Implementar:

- parse de `--visual-manifest`;
- descoberta segura de manifesto irmão;
- validação de hash antes de usar o manifesto;
- inclusão de instrução restrita no prompt: preservar os recursos já produzidos;
- comparação entre recursos observados no Markdown e no JSON;
- relatório `.visual-validation.json` sem conteúdo privado.

Não permitir que o LEIAUT substitua uma tabela obrigatória por Mermaid, ou Mermaid por lista, mesmo que julgue a alternativa mais legível.

### Pacote 6 — Bloqueio anterior à publicação

Alterar o fluxo de persistência do LEIAUT:

1. gerar e normalizar em memória;
2. validar estrutura e títulos;
3. validar Mermaid e segurança;
4. validar manifesto visual;
5. validar seções importáveis;
6. gravar em arquivo temporário no mesmo diretório;
7. renomear atomicamente para o nome definitivo;
8. gerar diagnóstico somente leitura.

Quando houver divergência obrigatória:

- retornar código de saída diferente de zero;
- não substituir JSON válido anterior;
- identificar arquivo, tópico, seção, requisito esperado e observado;
- marcar a execução como falha no resumo do lote.

### Pacote 7 — Correção de `topic_id`

Fonte de autoridade:

1. `topic_slug` aprovado no plano visual;
2. título canônico já normalizado;
3. nome do arquivo apenas como fallback.

Não tentar reconstruir palavras fragmentadas por OCR usando heurísticas silenciosas. Se o slug parecer fragmentado, rejeitar e solicitar valor canônico no plano.

Adicionar detector conservador de slug suspeito, considerando:

- excesso de segmentos de uma ou duas letras;
- comprimento desproporcional;
- repetição de separadores;
- conflito com slug já usado no lote.

Antes de reprocessar conteúdo já importado, produzir mapa explícito `topic_id_antigo → topic_id_novo`. Alteração de IDs existentes pode duplicar tópicos e romper URLs, progresso ou anotações; não executar migração de banco nesta tarefa sem autorização específica.

### Pacote 8 — Fixtures sem Vertex AI

Criar fixtures pequenas e artificiais, sem copiar o material integral:

```text
test/fixtures/visual/
  guide.visual.md
  visual-plan.valid.json
  visual-plan.invalid.json
  010-source.md
  010-output.md
  010-manifest.json
  022-source.md
  022-output.md
  022-manifest.json
  023-source.md
  023-output.md
  023-manifest.json
```

Cobrir:

- schema válido e inválido;
- hash divergente;
- variante estável;
- tabela obrigatória ausente;
- Mermaid obrigatório ausente ou malicioso;
- realce obrigatório ausente;
- recurso colocado na seção errada;
- manifesto de outro arquivo;
- slug suspeito e slug duplicado;
- retomada invalidada após mudança do plano;
- LEIAUT preservando o tipo de ferramenta;
- bloqueio antes de gravar JSON;
- preservação de saída antiga em falha.

### Pacote 9 — Pilotos 010, 022 e 023

Executar somente depois de todos os testes locais passarem.

#### 010 — Planejamento da auditoria

Requisitos mínimos:

- Mermaid de processo;
- realce da diferença entre estratégia global e plano;
- nenhuma tabela obrigatória se o plano não a exigir.

#### 022 — Relatório de auditoria

Requisitos mínimos:

- Mermaid de decisão para tipos de opinião;
- tabela da estrutura do relatório;
- realce da ordem entre opinião e base para opinião.

#### 023 — Perícia contábil

Requisitos mínimos:

- tabela de procedimentos;
- realce da pegadinha terminológica;
- decisão humana registrada sobre preservar ou substituir o mnemônico identificável.

Para cada piloto:

1. preservar fonte original;
2. usar diretório de saída novo;
3. registrar modelo, plano, hashes e seed;
4. não importar resultado parcial;
5. comparar fatos e recursos com checklist humano;
6. interromper o lote se qualquer piloto falhar.

Chamadas reais ao Vertex AI são permitidas apenas nesta etapa operacional e devem ser executadas conscientemente, fora dos testes.

### Pacote 10 — Validação visual no site

Importar somente os três pilotos aprovados em ambiente de desenvolvimento.

Validar:

- Light, Dark e Sepia;
- larguras aproximadas de 375, 768 e 1440 pixels;
- rolagem horizontal acessível em tabelas;
- ausência de overflow da página;
- Mermaid legível, seguro, com zoom e fallback;
- callouts com contraste e hierarquia adequados;
- navegação por teclado e foco visível;
- flashcards e mnemônicos sem regressão;
- ausência de HTML bruto e sinks inseguros.

Registrar capturas ou checklist por tópico e tema. Não aprovar o lote completo apenas porque lint, testes ou build passaram.

## 8. Gate de distância expressiva

Criar diagnóstico separado da fidelidade factual. Na primeira versão, ele deve bloquear apenas violações objetivas:

- trecho não normativo longo copiado literalmente;
- mesmos cabeçalhos, mesma ordem de linhas e mesmas dimensões de tabela;
- mesmos rótulos e mesma topologia do diagrama descrito no relatório;
- marca, autor, URL promocional ou identidade da fonte;
- repetição da mesma composição de realce.

Excluir da comparação literal:

- texto legal que deva ser reproduzido;
- nomes de normas;
- fórmulas;
- prazos e números;
- termos técnicos sem sinônimo seguro.

Não definir limiar percentual definitivo sem calibrar com os três pilotos. Registrar métricas primeiro e endurecer o gate somente após revisão humana.

## 9. Ordem de commits recomendada

Trabalhar em branches, por exemplo `feat/manifesto-visual`, e usar commits atômicos:

1. `feat(visual): definir schemas e convenções do manifesto`
2. `feat(pygem): compilar guia visual em plano validado`
3. `feat(pygem): selecionar variantes visuais determinísticas`
4. `feat(pygem): validar recursos obrigatórios por tópico`
5. `feat(leiaut): consumir manifesto visual do pygem`
6. `fix(leiaut): bloquear divergência antes da publicação`
7. `fix(ids): usar slug canônico e rejeitar fragmentação`
8. `test(visual): adicionar fixtures offline do pipeline`
9. `docs(visual): documentar pilotos e validação manual`

Executar push somente da branch de trabalho durante a implementação. Integrar em `main` apenas após revisão e autorização aplicável.

## 10. Verificações obrigatórias

PYGEM:

```powershell
npm.cmd run test:mermaid
npm.cmd run test:core
node test-visual-plan.js
```

LEIAUT:

```powershell
npm.cmd test
npm.cmd run check
```

Site, somente quando os pilotos forem importados ou o renderer for alterado:

```powershell
npm.cmd run lint
npx.cmd tsc --noEmit
npm.cmd run build -- --webpack
npm.cmd run test:content
```

Também executar busca por sinks e protocolos proibidos quando Mermaid ou Markdown forem tocados.

## 11. Critérios finais de aceite

- O mesmo relatório gera o mesmo plano e as mesmas variantes com a mesma seed.
- Cada tópico recebe somente seus próprios requisitos.
- Todo recurso obrigatório aparece no Markdown e no JSON, na seção prevista.
- Recurso obrigatório ausente impede publicação e preserva saída anterior.
- O JSON final mantém o contrato atual do site.
- `topic_id` novo é canônico, estável e não fragmentado.
- Nenhum teste automatizado chama Vertex AI.
- Os pilotos 010, 022 e 023 passam por revisão factual e visual.
- Light, Dark e Sepia foram verificados em desktop e mobile.
- O relatório de distância expressiva não encontra reprodução objetiva não autorizada.
- O lote completo não é iniciado antes da aprovação formal dos três pilotos.

## 12. Fora do escopo inicial

- migrations do Supabase;
- alteração do contrato Zod do site;
- novo renderer de `<mark>` ou HTML bruto;
- importação automática dos 24 tópicos;
- correção automática de conteúdo técnico ou normativo;
- garantia jurídica de não associação entre fonte e resultado;
- geração ou substituição silenciosa de mnemônicos existentes.

## 13. Estratégia de rollback

- Manter o fluxo sem guia visual como caminho compatível durante a implantação.
- Colocar o novo comportamento atrás da presença explícita de `--visual-guide`, `--visual-plan` ou manifesto irmão.
- Preservar a última saída válida quando a validação nova falhar.
- Permitir desativação operacional do consumo no LEIAUT por flag temporária documentada, sem remover validações de segurança.
- Não alterar IDs já publicados sem mapa de migração aprovado.
