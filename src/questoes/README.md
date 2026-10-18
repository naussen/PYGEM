# Comentários de questões em PDF

Pipeline local do PYGEM para questões já extraídas em JSON. A geração e as duas revisões usam exclusivamente Vertex AI por ADC. Os arquivos de origem permanecem intactos.

1. `commentar-pdfs.cjs` seleciona questões com gabarito definitivo ou reconciliado, resolve sem consultar o gabarito, gera comentários e executa uma primeira revisão. Cada lote contém até dez questões. Etapas intermediárias são salvas em `lotes*/` para retomada.
2. `render-calculations.py` cria PNGs da memória de cálculo quando o comentário quantitativo contém passos numéricos.
3. `audit-pro.cjs` verifica novamente os comentários com Gemini Pro e pesquisa na web. A revisão salva checkpoints em `auditoria_pro/`.
4. `assemble-commentary.py` só cria cópias dos JSONs de entrada quando todos os lotes e todas as auditorias Pro estão presentes. Questões anuladas, duvidosas ou reprovadas ficam sem `explanation` e são listadas em `relatorio_comentarios.json`.

O arquivo `auditoria_independente.json` contém retenções confirmadas na conferência editorial. O montador aplica essas retenções mesmo quando um modelo aprova o item.

A prova `dpf14_009_01` contém justificativa oficial embutida em todos os 120 enunciados extraídos. O pipeline separa essa justificativa antes de enviar a questão ao Vertex AI e antes de criar a cópia para o site. Os JSONs originais não são alterados. Checkpoints dessa prova criados antes da separação são preservados como inválidos e precisam ser gerados novamente com `--revalidate`.

Os JSONs resultantes permanecem com `import_ready: false`. É necessário revisar os apontamentos, mapear os tópicos do site e publicar as imagens por um endereço controlado antes de importar. O marcador 🔴 nos alertas de desatualização depende do renderizador do site para colorir o texto; o pipeline não injeta HTML no Markdown.

As chamadas ao Vertex consomem o projeto indicado por `GOOGLE_CLOUD_PROJECT`. O pipeline registra contagens de tokens quando a API as fornece, mas não consulta saldo, não impõe teto de créditos e não altera a conta de faturamento. Antes de uma execução longa, confira no Cloud Billing se a conta continua como avaliação gratuita e o saldo disponível.
