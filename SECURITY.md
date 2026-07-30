# Política de Segurança — PYGEM

## Autenticação do Vertex AI

O PYGEM usa Application Default Credentials (ADC). A aplicação não requer `GEMINI_API_KEY` e não deve armazenar tokens ou chaves no código.

Para desenvolvimento local, prefira:

```powershell
gcloud auth application-default login
```

Em ambientes gerenciados no Google Cloud, prefira uma identidade de serviço anexada ao recurso, com o menor conjunto de permissões necessário.

## Nunca faça commit de

- `.env` e suas variações locais
- Arquivos JSON de contas de serviço
- Chaves privadas (`.key`, `.pem`, `*.p12`)
- Tokens de acesso ou atualização
- Saídas de comandos de autenticação
- Logs que possam conter dados de entrada sensíveis

O `.gitignore` protege os padrões conhecidos, mas essa proteção não substitui a revisão manual antes de cada commit.

## Configuração segura

- O `.env.example` contém somente nomes e valores ilustrativos não secretos.
- `GOOGLE_CLOUD_PROJECT`, região e nomes de modelos não são credenciais.
- Se `GOOGLE_APPLICATION_CREDENTIALS` for indispensável, aponte para um arquivo mantido fora do repositório.
- Conceda à identidade somente os papéis necessários; para uso básico do Gemini no Vertex AI, normalmente é usado `roles/aiplatform.user`.
- Não registre prompts ou documentos sensíveis sem uma decisão explícita de segurança e retenção.

## Antes de fazer commit

```powershell
git diff --cached
git status --short
```

Confirme que não há credenciais, conteúdo processado, logs ou arquivos `.env` no conjunto preparado para commit.

## Reportar vulnerabilidades

Não publique credenciais nem detalhes exploráveis em issues públicas. Comunique a equipe responsável por um canal privado e aguarde confirmação antes da divulgação.
