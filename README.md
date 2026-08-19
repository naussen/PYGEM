# PYGEM — Reescrita didática com Vertex AI

Aplicação Node.js para reescrita didática de arquivos Markdown usando modelos Gemini no Google Cloud Vertex AI.

## Funcionalidades

- Reescrita inteligente de conteúdo `.md` com IA
- Processamento em lote por subpastas
- Remoção automática de numeração de módulos (ex.: "MÓDULO 2:")
- Geração automática de índice no início dos arquivos
- Processamento paralelo para arquivos pequenos
- Desligamento automático opcional após a conclusão
- Autenticação segura por Application Default Credentials (ADC), sem API key do Gemini

## Pré-requisitos

- Node.js 20 ou superior
- Google Cloud CLI (`gcloud`)
- Projeto Google Cloud com faturamento ativo
- API Vertex AI habilitada no projeto
- Identidade com o papel `Vertex AI User` (`roles/aiplatform.user`), ou permissões equivalentes

## Configuração do Google Cloud

Autentique o ambiente local com ADC:

```powershell
gcloud auth application-default login
```

Habilite a API Vertex AI no projeto, caso ainda não esteja habilitada:

```powershell
gcloud services enable aiplatform.googleapis.com --project=SEU_ID_DE_PROJETO
```

ADC usa a identidade local ou a identidade atribuída ao ambiente de execução. Não copie arquivos de credenciais para o repositório.

## Instalação

No diretório `C:\PRO\pygem`:

```powershell
npm install
Copy-Item .env.example .env
```

Edite somente os valores não sensíveis necessários no `.env`:

```env
GOOGLE_CLOUD_PROJECT=seu-id-de-projeto
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-3.5-flash
GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite
GEMINI_RECOVERY_MODEL=gemini-3.5-flash
GOOGLE_CLOUD_RECOVERY_LOCATION=global
PYGEM_THINKING_LEVEL=MINIMAL
GOOGLE_GENAI_API_VERSION=v1
```

## Uso

```powershell
npm start
```

Ou com configuração otimizada de performance:

```powershell
npm run start:optimized
```

Durante a execução, informe:

1. Diretório de entrada com os arquivos `.md` originais.
2. Diretório de saída dos arquivos reescritos.

Os arquivos originais são preservados, salvo quando uma opção explícita de substituição for escolhida pela aplicação.

Quando a primeira linha útil usa o marcador de título `@@ Título` ou `@@@ Título`, o PYGEM preserva essa linha literalmente na saída. A regra vale somente para o título do material; subtítulos e seções Markdown continuam sujeitos à reescrita e à normalização editorial. Além da instrução enviada ao modelo, o título original é restaurado deterministicamente antes da validação e da gravação.

## Plano visual v1

O PYGEM possui o contrato inicial para converter um relatório visual descritivo em um plano JSON validado. Essa compilação é offline, determinística e não chama o Vertex AI:

```powershell
npm.cmd run visual:compile -- C:\caminho\auditoria.visual.md --discipline "Auditoria"
```

Por padrão, `auditoria.visual.md` gera `auditoria.visual-plan.json` no mesmo diretório. Também é possível definir identificador, semente e saída:

```powershell
npm.cmd run visual:compile -- C:\caminho\auditoria.visual.md `
  --discipline "Auditoria" `
  --guide-id auditoria-visual-v1 `
  --seed auditoria-v1 `
  --output C:\saida\auditoria.visual-plan.json
```

Convenções desta versão:

- tópicos do relatório usam cabeçalhos `###`;
- o compilador ignora seções de sumário/índice;
- a parte `Correção recomendada para Markdown` prevalece sobre a descrição do layout original;
- um índice de arquivo só é associado quando declarado como `[arquivo: 010]` ou por nome explícito como `010_arquivo.md`;
- o plano nunca infere silenciosamente que o número da seção do relatório corresponde ao número do arquivo;
- hashes SHA-256 vinculam o plano ao relatório literal;
- um manifesto de arquivo aceita vários tópicos visuais agrupados.

Os schemas ficam em `src/visual/schemas`. Nesta etapa o plano ainda não é injetado automaticamente na reescrita principal; essa integração pertence à próxima fase do fluxo.

## Variáveis de ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | ID do projeto Google Cloud | obrigatória |
| `GOOGLE_CLOUD_LOCATION` | Região do endpoint Vertex AI | `global` |
| `GOOGLE_GENAI_API_VERSION` | Versão da API usada pelo SDK | `v1` |
| `GEMINI_MODEL` | Modelo principal no Vertex AI; o `.env.example` recomenda 3.5 | `gemini-2.5-flash` quando ausente |
| `GEMINI_FALLBACK_MODEL` | Modelo usado em caso de indisponibilidade; o `.env.example` recomenda 3.5 Lite | `gemini-2.5-flash-lite` quando ausente |
| `GEMINI_RECOVERY_MODEL` | Recuperação final de fragmento mínimo após principal e fallback falharem | `gemini-3.5-flash` |
| `GOOGLE_CLOUD_RECOVERY_LOCATION` | Endpoint separado do modelo de recuperação | `global` |
| `INPUT_DIR` | Diretório de entrada opcional | solicitado na execução |
| `OUTPUT_DIR` | Diretório de saída opcional | solicitado na execução |
| `USE_OPTIMIZED_CONFIG` | Usa a configuração otimizada (`true`) | `false` |
| `PYGEM_SKIP_CONNECTION_TEST` | Pula o teste inicial de conexão em execução automatizada (`true`) | `false` |
| `PYGEM_AUTO_SHUTDOWN` | Define desligamento automático sem prompt; use `false` em automações | solicitado na execução |
| `PYGEM_MAX_OUTPUT_RATIO` | Limite proporcional de expansão da saída | `3` |
| `PYGEM_MAX_OUTPUT_TOKEN_MULTIPLIER` | Margem proporcional aplicada ao tamanho da unidade | `1.1` |
| `PYGEM_MIN_OUTPUT_TOKENS` | Piso do limite de tokens por resposta | `1024` |
| `PYGEM_MAX_OUTPUT_TOKENS` | Limite global aceito pela configuração, respeitando o máximo do modelo | `65536` |
| `PYGEM_MAX_OUTPUT_TOKENS_PER_REQUEST` | Teto operacional por geração; impede respostas patológicas gigantes | `8192` |
| `PYGEM_OUTPUT_RESERVE_TOKENS` | Reserva fixa somada ao orçamento proporcional | `256` |
| `PYGEM_MAX_GENERATION_ATTEMPTS` | Tentativas locais para corrigir omissão ou estrutura; limitado a duas | `2` |
| `PYGEM_THINKING_BUDGET` | Orçamento de thinking na reescrita; `0` desabilita | `0` |
| `PYGEM_THINKING_LEVEL` | Nível de thinking para Gemini 3 ou superior (`MINIMAL`, `LOW`, `MEDIUM`, `HIGH`) | `MINIMAL` |
| `PYGEM_REQUEST_TIMEOUT_MS` | Timeout de cada chamada ao Vertex AI | `120000` |
| `PYGEM_MAX_REQUEST_RETRIES` | Repetições da mesma requisição em erros temporários 429/503; limitado a duas | `1` |
| `PYGEM_REQUEST_RETRY_INITIAL_DELAY_MS` | Espera inicial do backoff exponencial de capacidade | `10000` |
| `PYGEM_REQUEST_RETRY_MAX_DELAY_MS` | Limite do backoff de capacidade | `60000` |
| `PYGEM_REQUEST_RETRY_JITTER_RATIO` | Variação aleatória aplicada ao backoff para suavizar picos | `0.25` |
| `PYGEM_MAX_API_CALLS_PER_ROOT_BLOCK` | Orçamento total compartilhado por um bloco, fallbacks e subdivisões | `8` |
| `PYGEM_MAX_API_CALLS_PER_FILE_MULTIPLIER` | Multiplicador do número de blocos para o orçamento global do arquivo | `2.5` |
| `PYGEM_MAX_API_CALLS_PER_FILE_RESERVE` | Reserva fixa de chamadas do arquivo | `4` |
| `PYGEM_SINGLE_PASS_MAX_INPUT_TOKENS` | Entrada máxima para reescrita sem divisão | `1600` |
| `PYGEM_BLOCK_INPUT_TOKENS` | Teto-alvo dos blocos de entrada | `1200` |
| `PYGEM_MIN_RECOVERY_BLOCK_TOKENS` | Menor fragmento permitido na recuperação de uma saída rejeitada | `300` |
| `PYGEM_MAX_BLOCK_SUBDIVISION_DEPTH` | Níveis máximos de subdivisão para recuperação | `3` |
| `PYGEM_CHECKPOINT_ENABLED` | Persiste blocos válidos de arquivos grandes para retomada (`false` desabilita) | `true` |
| `PYGEM_MAX_CONCURRENT_REQUESTS` | Chamadas simultâneas no modo otimizado; aumente somente com cota comprovada | `1` |

## Saídas individuais e execuções incompletas

Cada arquivo de origem produz exatamente um arquivo Markdown independente com o sufixo `_reescrito.md`. A estrutura relativa das subpastas é preservada na saída: por exemplo, `entrada\direito\005.md` gera `saída\direito\005_reescrito.md`. Isso também impede colisões quando subpastas diferentes possuem arquivos com o mesmo nome.

Cada resultado só é publicado depois de validado e por meio de gravação atômica. Se um item do lote falhar, os demais arquivos concluídos permanecem disponíveis e não são reunidos em um agregado parcial. O arquivo `_pygem.manifest.json` de cada diretório registra `status: "complete"` ou `status: "incomplete"`, as saídas publicadas, a impressão digital SHA-256 das fontes e os arquivos que precisam ser reprocessados. Na retomada, arquivos já publicados só são reutilizados quando a fonte continua idêntica; arquivos alterados voltam automaticamente para a fila.

Durante arquivos divididos em blocos, cada bloco válido é gravado atomicamente em `logs/checkpoints`. Uma nova execução só reutiliza o checkpoint quando os hashes da fonte, do prompt, do modelo e da política de geração coincidem. O checkpoint é removido quando todos os blocos terminam reescritos; se algum bloco precisar ser preservado sem reescrita, o arquivo é declarado incompleto e não é publicado como sucesso. O checkpoint permanece para que a próxima execução tente somente as partes pendentes.

## Validação editorial da saída

Além da sintaxe Mermaid e dos limites proporcionais de saída, o PYGEM valida a estrutura Markdown antes de aceitar ou gravar um material. A saída é rejeitada quando contém linhas patologicamente longas, sequências excessivas de espaços, marcadores internos de falha, o erro conhecido `DOUTINA` ou títulos descritivos predominantemente em maiúsculas. Siglas canônicas, como `CIDE`, `ICMS`, `ISS`, `NBC`, `TA` e `TI`, permanecem em maiúsculas.

Uma resposta só é aceita quando o Vertex AI informa término natural `STOP`. Respostas `MAX_TOKENS`, `RECITATION`, `SAFETY` ou com outro motivo de interrupção nunca são publicadas parcialmente. Em `MAX_TOKENS`, expansão excessiva ou loop de repetição, o PYGEM tenta uma vez o modelo fallback com o mesmo teto e só então subdivide. Se um fragmento já estiver no tamanho mínimo e os dois modelos falharem, usa o modelo de recuperação 3.5 no endpoint `global`. O orçamento de saída nunca cresce, e o orçamento de chamadas é compartilhado entre o arquivo, o bloco raiz, fallbacks e subdivisões, impedindo multiplicação recursiva. Se a recuperação limitada não for suficiente, o bloco original é preservado apenas na montagem segura em memória, o arquivo é marcado como incompleto e os blocos válidos ficam no checkpoint. A cobertura dos títulos da fonte é conferida novamente no fluxo sequencial, paralelo e nos fallbacks.

O perfil recomendado no `.env.example` para novas configurações usa `gemini-3.5-flash` com `thinkingLevel=MINIMAL`, adequado a uma transformação textual que não exige raciocínio agentivo longo, e `gemini-3.5-flash-lite` apenas como fallback de capacidade. Ambos são GA. O fallback interno, usado quando `GEMINI_MODEL` não está definido, permanece temporariamente em 2.5 para não combinar silenciosamente arquivos `.env` legados em `us-central1` com modelos 3.5 incompatíveis com essa região. O PYGEM adapta a configuração por família: Gemini 2.5 recebe `thinkingBudget`; Gemini 3 ou superior recebe `thinkingLevel`; no Flash-Lite 3.5, parâmetros de amostragem que o modelo não aceita são omitidos.

O `gemini-2.5-flash` permanece aceito quando configurado explicitamente, mas sua desativação está prevista para outubro de 2026. Para migrar, altere conjuntamente `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` e `GOOGLE_CLOUD_LOCATION=global`; os modelos 3.5 não estão disponíveis em `us-central1`. Como o checkpoint inclui o modelo em seu hash, a primeira execução após a troca gera unidades novas e não mistura respostas de famílias diferentes.

O modo otimizado altera esperas e agrupamento, mas usa a mesma configuração determinística de geração do modo normal. Por segurança operacional, executa uma requisição por vez por padrão; `PYGEM_MAX_CONCURRENT_REQUESTS` permite aumento consciente quando a cota do projeto comportar concorrência.

Execute as verificações locais com:

```powershell
npm.cmd run test:mermaid
npm.cmd run test:core
npm.cmd run test:visual
```

## Estrutura

```text
PYGEM/
├── src/
│   ├── app-md.js
│   ├── launcher.js
│   ├── config/
│   │   ├── gemini.js
│   │   └── gemini-optimized.js
│   ├── services/
│   └── utils/
├── .env.example
└── package.json
```

## Solução de problemas

- `Could not load the default credentials`: execute `gcloud auth application-default login`.
- `PERMISSION_DENIED`: confirme a API Vertex AI e o papel `roles/aiplatform.user`.
- Modelo não encontrado: verifique se o modelo está disponível em `GOOGLE_CLOUD_LOCATION` ou use `global`.
- `RESOURCE_EXHAUSTED`/`429`: consulte as cotas do Vertex AI do projeto e aguarde antes de repetir.

## Licença

MIT
