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

No diretório `C:\PYGEM`:

```powershell
npm install
Copy-Item .env.example .env
```

Edite somente os valores não sensíveis necessários no `.env`:

```env
GOOGLE_CLOUD_PROJECT=seu-id-de-projeto
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-2.5-flash
GEMINI_FALLBACK_MODEL=gemini-2.5-flash-lite
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

## Variáveis de ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | ID do projeto Google Cloud | obrigatória |
| `GOOGLE_CLOUD_LOCATION` | Região do endpoint Vertex AI | `global` |
| `GOOGLE_GENAI_API_VERSION` | Versão da API usada pelo SDK | `v1` |
| `GEMINI_MODEL` | Modelo principal no Vertex AI | `gemini-2.5-flash` |
| `GEMINI_FALLBACK_MODEL` | Modelo usado em caso de indisponibilidade | `gemini-2.5-flash-lite` |
| `INPUT_DIR` | Diretório de entrada opcional | solicitado na execução |
| `OUTPUT_DIR` | Diretório de saída opcional | solicitado na execução |
| `USE_OPTIMIZED_CONFIG` | Usa a configuração otimizada (`true`) | `false` |
| `PYGEM_SKIP_CONNECTION_TEST` | Pula o teste inicial de conexão em execução automatizada (`true`) | `false` |
| `PYGEM_MAX_OUTPUT_RATIO` | Limite proporcional de expansão da saída | `3` |
| `PYGEM_MAX_OUTPUT_TOKEN_MULTIPLIER` | Margem para calcular o limite de tokens da resposta | `1.25` |
| `PYGEM_MIN_OUTPUT_TOKENS` | Piso do limite de tokens por resposta | `2048` |
| `PYGEM_MAX_FILE_RETRIES` | Tentativas adicionais para erros transitórios por arquivo | `2` |
| `PYGEM_MAX_GENERATION_ATTEMPTS` | Tentativas de validação da resposta do modelo | `3` |
| `PYGEM_MAX_CONTINUATIONS` | Continuações permitidas quando a resposta atingir `MAX_TOKENS` | `2` |

## Validação editorial da saída

Além da sintaxe Mermaid e dos limites proporcionais de saída, o PYGEM valida a estrutura Markdown antes de aceitar ou gravar um material. A saída é rejeitada quando contém linhas patologicamente longas, sequências excessivas de espaços, marcadores internos de falha, o erro conhecido `DOUTINA` ou títulos descritivos predominantemente em maiúsculas. Siglas canônicas, como `CIDE`, `ICMS`, `ISS`, `NBC`, `TA` e `TI`, permanecem em maiúsculas.

Execute as verificações locais com:

```powershell
npm.cmd run test:mermaid
npm.cmd run test:core
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
