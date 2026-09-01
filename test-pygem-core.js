const assert = require('assert');
const config = require('./src/config/runtime');
const optimizedConfig = require('./src/config/gemini-optimized');
const {
    isOutputTooShort,
    isOutputTooLong,
    normalizeInlineTopicMarkers,
    stripStandaloneTechnicalMarkers,
    getBlockPrompt,
    detectRepetitionLoop,
    prepareContentForRewrite,
    finalizeRewrittenContent,
    extractOriginalDocumentTitleLine,
} = require('./src/utils/contentPreprocessor');
const {
    splitContentIntoBlocks,
    createMarkdownSegments,
    estimateTokens,
} = require('./src/services/tokenService');
const { getRewritingPrompt } = require('./src/services/promptServiceMd');
const {
    getRewrittenOutputPath,
    writeRewrittenFileAtomic,
    writeDirectoryProcessingManifest,
    getReusableManifestEntries,
} = require('./src/services/fileServiceMd');
const { diagnostics: geminiDiagnostics } = require('./src/services/geminiService');
const PerformanceLogger = require('./src/services/performanceLogger');
const { createRewriteCheckpoint } = require('./src/services/rewriteCheckpointService');
const {
    validateMarkdownQuality,
    validateGeneratedContent,
    validateSourceHeadingCoverage,
} = require('./src/utils/validation');
const { normalizeUppercaseHeadings } = require('./src/utils/contentProcessor');

assert.strictEqual(isOutputTooShort('a'.repeat(100), 'a'.repeat(80), 0.75), false);
assert.strictEqual(
    geminiDiagnostics.shouldPreserveShortSourceAfterThinkingLeak(
        'texto curto',
        { code: 'PYGEM_OUTPUT_INVALID', details: { reason: 'thinking_leak' } }
    ),
    true
);
assert.strictEqual(
    geminiDiagnostics.shouldPreserveShortSourceAfterThinkingLeak(
        'texto curto',
        { code: 'PYGEM_OUTPUT_INVALID', details: { reason: 'too_long' } }
    ),
    false
);
assert.strictEqual(isOutputTooShort('a'.repeat(1000), 'a'.repeat(350)), true);
assert.strictEqual(isOutputTooShort('a'.repeat(1000), 'a'.repeat(650)), false);
assert.strictEqual(isOutputTooLong('a'.repeat(100), 'a'.repeat(301), 3), false);
assert.strictEqual(isOutputTooLong('a'.repeat(1000), 'a'.repeat(3001), 3), true);
assert.strictEqual(isOutputTooLong('a'.repeat(100), 'a'.repeat(300), 3), false);
assert.strictEqual(isOutputTooLong('a'.repeat(1000), 'a'.repeat(4000)), false);
assert.strictEqual(
    normalizeInlineTopicMarkers(
        '@@@ ## Empresa e Empresário\n\nTexto.\n\n@@@\n## Registro\n\n@@@ ### Subtítulo'
    ),
    '@@@\n## Empresa e Empresário\n\nTexto.\n\n@@@\n## Registro\n\n@@@ ### Subtítulo'
);
assert.match(getBlockPrompt('Prompt', 2, 3), /não invente nem repita o marcador/u);
assert.strictEqual(
    normalizeUppercaseHeadings('## OPINIÃO DO AUDITOR (NBC TA)\n\nTexto.'),
    '## Opinião do Auditor (NBC TA)\n\nTexto.'
);

const originalDocumentTitle = '@@@ LEI de Introdução: LINDB (ORIGINAL)';
const auditoriaSource = '@@ AU DIT ORIA INT ERN A (N B C TI 01 )\n\nResumo.';
const auditoriaPrepared = prepareContentForRewrite(auditoriaSource, '001_Auditoria.md');
assert.strictEqual(
    finalizeRewrittenContent('@@ Au dit oria int ern a (n b C TI 01 )\n\nResumo reescrito.', auditoriaPrepared),
    '@@ Auditoria interna (NBC TI 01)\n\nResumo reescrito.'
);
assert.strictEqual(
    finalizeRewrittenContent(
        '@@ Título desformatado\n\nTexto.',
        prepareContentForRewrite('@@ Título desformatado\n\nTexto.', 'outro.md')
    ),
    '@@ Título desformatado\n\nTexto.'
);
assert.strictEqual(
    stripStandaloneTechnicalMarkers('@@@\n## Empresa e Empresário\n\nTexto.'),
    '## Empresa e Empresário\n\nTexto.'
);
assert.strictEqual(
    stripStandaloneTechnicalMarkers('@@ Direito de Empresa\n\nTexto.'),
    '# Direito de Empresa\n\nTexto.'
);
const markdownTitleSource = '# Direito de Empresa\n\n## Empresa e Empresário\n\nTexto.';
assert.strictEqual(
    finalizeRewrittenContent(
        '@@ Direito de Empresa\n\n## Empresa e Empresário\n\nTexto reescrito.',
        prepareContentForRewrite(markdownTitleSource)
    ),
    '# Direito de Empresa\n\n## Empresa e Empresário\n\nTexto reescrito.'
);
const sourceWithImmutableTitle = `${originalDocumentTitle}\n\n## Seção ORIGINAL\n\nTexto.`;
const preparedWithImmutableTitle = prepareContentForRewrite(sourceWithImmutableTitle);
assert.strictEqual(
    extractOriginalDocumentTitleLine(sourceWithImmutableTitle),
    originalDocumentTitle
);
assert.strictEqual(
    finalizeRewrittenContent(
        '@@@ Lei de introdução: Lindb (alterado)\n\n## Seção reescrita\n\nTexto didático.',
        preparedWithImmutableTitle
    ),
    `${originalDocumentTitle}\n\n## Seção reescrita\n\nTexto didático.`
);
assert.strictEqual(
    extractOriginalDocumentTitleLine('@@@\n## Seção do sumário\n\nTexto.'),
    null
);
assert.strictEqual(
    extractOriginalDocumentTitleLine('@@ Título ORIGINAL com dois arrobas\n### Subtítulo'),
    '@@ Título ORIGINAL com dois arrobas'
);
assert.strictEqual(
    finalizeRewrittenContent(
        '## Seção reescrita\n\nTexto.\n\n@@@ Marcador posterior preservado',
        preparedWithImmutableTitle
    ),
    `${originalDocumentTitle}\n## Seção reescrita\n\nTexto.\n\n@@@ Marcador posterior preservado`
);
assert.match(
    getRewritingPrompt(),
    /TÍTULO DO MATERIAL[\s\S]*metadado imutável[\s\S]*subtítulos nem a seções Markdown/u
);
const blocksWithResidualTail = splitContentIntoBlocks(
    `${'conteúdo longo '.repeat(130)}\n# Continuação\n${'final '.repeat(10)}`,
    600
);
assert.strictEqual(blocksWithResidualTail.length, 1);
assert.ok(estimateTokens(blocksWithResidualTail[0]) <= 600);
assert.ok(config.outputPolicy.maxOutputRatio >= 1);
assert.ok(config.retry.maxGenerationAttempts >= 1);
assert.ok(config.retry.maxRequestRetries <= 2);
assert.ok(config.retry.requestRetryInitialDelayMs >= 1000);
assert.ok(config.retry.requestRetryMaxDelayMs >= config.retry.requestRetryInitialDelayMs);
const shortContentOutputBudget = geminiDiagnostics.calculateMaxOutputTokens('trecho curto');
assert.strictEqual(
    shortContentOutputBudget,
    Math.min(
        config.generationConfig.maxOutputTokens,
        config.outputPolicy.minOutputTokens
    )
);
assert.strictEqual(
    geminiDiagnostics.calculateMaxOutputTokens('trecho curto', undefined, 2),
    shortContentOutputBudget
);
assert.strictEqual(
    geminiDiagnostics.calculateMaxOutputTokens('trecho curto', undefined, 4),
    shortContentOutputBudget
);
assert.ok(config.processing.singlePassMaxInputTokens < 5000);
assert.ok(config.processing.blockInputTokens <= config.processing.singlePassMaxInputTokens);
assert.ok(config.processing.minRecoveryBlockTokens < config.processing.blockInputTokens);
assert.ok(config.processing.maxBlockSubdivisionDepth >= 2);
assert.ok(config.outputPolicy.minOutputTokens >= 256);
assert.ok(config.outputPolicy.minOutputTokens <= config.generationConfig.maxOutputTokens);
assert.ok(config.outputPolicy.maxOutputTokensPerRequest <= 8192);
assert.ok(config.generationConfig.maxOutputTokens <= 65536);
assert.ok(config.outputPolicy.maxOutputTokenMultiplier >= 1);
assert.ok(config.generationConfig.temperature <= 0.2);
assert.ok(config.generationConfig.httpOptions.timeout >= 10000);
assert.strictEqual(optimizedConfig.generationConfig.temperature, config.generationConfig.temperature);
assert.ok(optimizedConfig.batch.maxConcurrent >= 1);
assert.ok(config.generationConfig.thinkingConfig.thinkingBudget >= 0);
assert.strictEqual(config.generationConfig.thinkingConfig.includeThoughts, false);
const gemini35Config = geminiDiagnostics.buildGenerationConfig(
    { maxOutputTokens: 2048 },
    'gemini-3.5-flash'
);
assert.strictEqual(gemini35Config.maxOutputTokens, 2048);
assert.strictEqual(gemini35Config.thinkingConfig.thinkingLevel, 'MINIMAL');
assert.strictEqual('thinkingBudget' in gemini35Config.thinkingConfig, false);
assert.strictEqual('topK' in gemini35Config, false);
const gemini35LiteConfig = geminiDiagnostics.buildGenerationConfig(
    { maxOutputTokens: 2048, temperature: 0.1 },
    'gemini-3.5-flash-lite'
);
assert.strictEqual('temperature' in gemini35LiteConfig, false);
assert.strictEqual('topP' in gemini35LiteConfig, false);
assert.deepStrictEqual(
    config.getModelCompatibilityIssues('gemini-3.5-flash-lite', 'us-central1'),
    ['gemini-3.5-flash-lite requer GOOGLE_CLOUD_LOCATION=global, us ou eu.']
);
assert.deepStrictEqual(
    config.getModelCompatibilityIssues('gemini-3.5-flash', 'global'),
    []
);
assert.strictEqual(config.recoveryModel, 'gemini-3.5-flash');
assert.strictEqual(config.recoveryLocation, 'global');
assert.strictEqual(config.model, 'gemini-3.5-flash');
assert.strictEqual(config.fallbackModel, 'gemini-3.5-flash-lite');
assert.match(getRewritingPrompt(), /RECURSOS DIDÁTICOS \(USE COM CRITÉRIO\)/u);
assert.match(getRewritingPrompt(), /capitalização editorial/u);
assert.match(getRewritingPrompt(), /conclusão e fidelidade têm prioridade/u);
assert.match(getRewritingPrompt(), /elimine primeiro recursos opcionais/u);
assert.match(getBlockPrompt('Prompt', 1, 2), /Não crie flashcards, Mermaid/u);

const pathologicalRepetition = Array.from(
    { length: 50 },
    () => 'Este parágrafo artificial possui extensão suficiente e foi repetido integralmente para simular um loop patológico do modelo.'
).join('\n');
assert.strictEqual(detectRepetitionLoop(pathologicalRepetition).detected, true);
assert.strictEqual(
    detectRepetitionLoop(pathologicalRepetition, pathologicalRepetition).detected,
    false
);
assert.strictEqual(
    detectRepetitionLoop('Art. 1º A lei aplica-se.\nArt. 2º A lei aplica-se.\nArt. 3º A lei aplica-se.').detected,
    false
);

const fencedMarkdown = [
    '## Primeiro tema',
    '',
    'Texto introdutório.',
    '',
    '```text',
    '## Isto está dentro da cerca',
    'linha preservada',
    '```',
    '',
    '## Segundo tema',
    '',
    'Texto final.',
].join('\n');
const fencedSegments = createMarkdownSegments(fencedMarkdown, 30);
assert.strictEqual(fencedSegments.filter(segment => segment.includes('```text')).length, 1);
assert.match(fencedSegments.find(segment => segment.includes('```text')), /## Isto está dentro da cerca/u);
const largeSyntheticMarkdown = Array.from({ length: 30 }, (_, index) => (
    `## Tema ${index + 1}\n\n${'Parágrafo juridicamente relevante com ordem preservada. '.repeat(18)}`
)).join('\n\n');
const largeSyntheticBlocks = splitContentIntoBlocks(largeSyntheticMarkdown, 1200);
assert.ok(largeSyntheticBlocks.length > 10);
assert.strictEqual(
    largeSyntheticBlocks.join('\n\n').replace(/\s+/g, ' ').trim(),
    largeSyntheticMarkdown.replace(/\s+/g, ' ').trim()
);
assert.ok(
    largeSyntheticBlocks.every(block => estimateTokens(block) <= 1200 * 1.15)
);

const uppercaseHeading = validateMarkdownQuality('## AUDITORIA INTERNA (NBC TI 01)\n\nConteúdo.');
assert.ok(
    !uppercaseHeading.valid
    && uppercaseHeading.issues.some(issue => issue.includes('predominantemente em maiúsculas'))
);
assert.strictEqual(
    validateMarkdownQuality(
        '## ESPÉCIES DE TENTATIVA\n\nConteúdo organizado.',
        { sourceMarkdown: 'ESP É CIE S DE TEN TATIVA\nTexto extraído por OCR.' }
    ).valid,
    true
);
assert.strictEqual(
    validateMarkdownQuality(
        '## TÍTULO INVENTADO\n\nConteúdo organizado.',
        { sourceMarkdown: 'Texto original sem esse título.' }
    ).valid,
    false
);

assert.strictEqual(
    validateMarkdownQuality('## ICMS\n\nConteúdo.').valid,
    true
);
assert.strictEqual(
    validateSourceHeadingCoverage(
        '# MÓDULO\n## Primeiro tema\n### Detalhes\nTexto.\n## Segundo tema\nTexto.',
        '# Módulo\n## Primeiro tema\n### Detalhes\nTexto reescrito.\n## Segundo tema\nTexto.'
    ).valid,
    true
);
const incompleteHeadingCoverage = validateSourceHeadingCoverage(
    '## Primeiro tema\nTexto.\n## Segundo tema\nTexto.',
    '## Primeiro tema\nTexto reescrito.'
);
assert.strictEqual(incompleteHeadingCoverage.valid, false);
assert.match(incompleteHeadingCoverage.issues[0], /Segundo tema/u);
const extraMainHeading = validateSourceHeadingCoverage(
    '## Primeiro tema\nTexto.\n## Segundo tema\nTexto.',
    '## Primeiro tema\nTexto.\n## Tema inventado\nTexto.\n## Segundo tema\nTexto.'
);
assert.strictEqual(extraMainHeading.valid, false);
assert.ok(extraMainHeading.issues.some(issue => issue.includes('títulos ## divergente')));
assert.strictEqual(
    validateSourceHeadingCoverage(
        '```text\n## Não é título estrutural\n```\n## Título real\nTexto.',
        '## Título real\nTexto.'
    ).valid,
    true
);
assert.strictEqual(
    validateMarkdownQuality('## CIDE Combustíveis\n\nConteúdo.').valid,
    true
);
assert.strictEqual(
    validateMarkdownQuality('## IPVA\n\nO IPVA é um imposto estadual.').valid,
    true
);
assert.strictEqual(
    validateMarkdownQuality('## ERRO\n\nO erro é uma distorção não intencional.').valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality('## Princípios de controle interno (DOUTINA)\n\nConteúdo.').valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality(`## Tabela\n\n| Campo | ${' '.repeat(1001)}Descrição |`).valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality(`[image1]: <data:image/png;base64,${'A'.repeat(25000)}>`).valid,
    true
);
assert.strictEqual(
    validateGeneratedContent('[ERRO: Não foi possível reescrever o bloco 2]').valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality(
        '@@@ ## Escrituração\n\nConteúdo.\n\n@@@\n## escrituração\n\nContinuação.'
    ).valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality(
        '@@@\n## Administração pública\n\n@@@\n## Disposições gerais\n\nConteúdo.'
    ).valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality('@@ Marcador de corte\n\nConteúdo.').valid,
    false
);
assert.strictEqual(
    validateMarkdownQuality(
        '## Administração pública\n\n### Princípios\n\nConteúdo.'
    ).valid,
    true
);

assert.ok(
    geminiDiagnostics.calculateMaxOutputTokens('conteúdo curto')
    >= config.outputPolicy.minOutputTokens
);
assert.ok(
    geminiDiagnostics.calculateMaxOutputTokens('conteúdo '.repeat(500), 3, 1.6),
    geminiDiagnostics.calculateMaxOutputTokens('conteúdo '.repeat(500), 3, 1)
);
assert.ok(
    geminiDiagnostics.calculateMaxOutputTokens('conteúdo '.repeat(5000))
    <= config.outputPolicy.maxOutputTokensPerRequest
);
const boundedRequestBudget = geminiDiagnostics.createRequestBudget('teste', 2);
assert.strictEqual(boundedRequestBudget.consume(), 1);
assert.strictEqual(boundedRequestBudget.consume(), 2);
assert.throws(() => boundedRequestBudget.consume(), /Orçamento de 2 chamadas/u);
const parentBudget = geminiDiagnostics.createRequestBudget('arquivo', 2);
const childBudget = geminiDiagnostics.createRequestBudget('bloco', 5, parentBudget);
assert.strictEqual(childBudget.consume(), 1);
assert.strictEqual(childBudget.consume(), 2);
assert.throws(() => childBudget.consume(), /arquivo/u);
assert.strictEqual(childBudget.used, 2);
const partialRewriteError = geminiDiagnostics.createPartialRewriteError(
    [{ blockNumber: 2, error: 'falha controlada' }],
    4
);
assert.strictEqual(partialRewriteError.code, 'PYGEM_PARTIAL_REWRITE');
assert.match(partialRewriteError.message, /não publicado: 1 de 4 bloco/u);
assert.strictEqual(partialRewriteError.details[0].blockNumber, 2);
assert.strictEqual(
    geminiDiagnostics.calculateRequestRetryDelayMs(0, 0, 0),
    config.retry.requestRetryInitialDelayMs
);
assert.strictEqual(
    geminiDiagnostics.calculateRequestRetryDelayMs(10, 0, 1),
    config.retry.requestRetryMaxDelayMs
);
assert.strictEqual(
    geminiDiagnostics.calculateRequestRetryDelayMs(
        0,
        config.retry.requestRetryMaxDelayMs + 15000,
        0
    ),
    config.retry.requestRetryMaxDelayMs + 15000
);
assert.strictEqual(
    geminiDiagnostics.isTransientCapacityError(
        new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')
    ),
    true
);
assert.strictEqual(
    validateSourceHeadingCoverage(
        '## MÓDULO 2: Serviços públicos\nTexto.',
        '## Serviços públicos\nTexto reescrito.'
    ).valid,
    true
);
assert.strictEqual(
    geminiDiagnostics.isTransientCapacityError(new Error('PERMISSION_DENIED')),
    false
);
assert.strictEqual(
    geminiDiagnostics.isRequestTimeoutError(new Error('Request timed out after 180000ms')),
    true
);
assert.strictEqual(geminiDiagnostics.isSuccessfulFinishReason('STOP'), true);
assert.strictEqual(geminiDiagnostics.isSuccessfulFinishReason('MAX_TOKENS'), false);
assert.strictEqual(geminiDiagnostics.isSuccessfulFinishReason('RECITATION'), false);
assert.strictEqual(geminiDiagnostics.isSuccessfulFinishReason(null), false);
assert.match(
    geminiDiagnostics.getRetryInstruction({
        reason: geminiDiagnostics.GENERATION_FAILURE.MAX_TOKENS,
    }),
    /truncada/u
);
assert.match(
    geminiDiagnostics.getRetryInstruction({
        reason: geminiDiagnostics.GENERATION_FAILURE.FINISH_REASON,
        finishReason: 'RECITATION',
    }),
    /RECITATION/u
);
assert.match(
    geminiDiagnostics.getContentScaleInstruction('conteúdo curto'),
    /Não crie Mermaid, flashcards, tabelas/u
);
assert.match(
    geminiDiagnostics.getContentScaleInstruction('conteúdo '.repeat(250)),
    /no máximo um recurso didático opcional/u
);
assert.match(
    geminiDiagnostics.buildAttemptPrompt(
        'Prompt base',
        'Conteúdo original',
        {
            reason: geminiDiagnostics.GENERATION_FAILURE.INVALID_STRUCTURE,
            details: 'título duplicado',
        }
    ),
    /CORREÇÃO DA NOVA TENTATIVA[\s\S]*título duplicado/u
);
assert.match(
    geminiDiagnostics.getRetryInstruction({
        reason: geminiDiagnostics.GENERATION_FAILURE.INVALID_STRUCTURE,
        details: 'linha 3: contém HTML <br> fora de Mermaid.',
    }),
    /substitua cada <br> ou <br\/> por uma quebra de linha Markdown/u
);
assert.strictEqual(
    geminiDiagnostics.replaceLineBreakTagsOutsideMermaid('Texto<br/>seguinte\n```mermaid\ngraph TD\nA[Um<br/>Dois] --> B\n```'),
    'Texto\nseguinte\n```mermaid\ngraph TD\nA[Um<br/>Dois] --> B\n```'
);
assert.strictEqual(
    geminiDiagnostics.replaceLineBreakTagsOutsideMermaid('| Regra | Exemplo<br/>Complemento |'),
    '| Regra | Exemplo; Complemento |'
);
assert.strictEqual(
    geminiDiagnostics.shouldRewriteInBlocks(config.processing.singlePassMaxInputTokens),
    false
);
assert.strictEqual(
    geminiDiagnostics.shouldRewriteInBlocks(config.processing.singlePassMaxInputTokens + 1),
    true
);

const recoverableTruncation = new Error('resposta truncada');
recoverableTruncation.code = 'PYGEM_OUTPUT_INVALID';
recoverableTruncation.details = {
    reason: geminiDiagnostics.GENERATION_FAILURE.MAX_TOKENS,
};
const recoverySource = [
    '## Primeiro tema',
    ...Array.from({ length: 60 }, () => 'Conteúdo do primeiro tema com extensão realista.'),
    '## Segundo tema',
    ...Array.from({ length: 60 }, () => 'Conteúdo do segundo tema com extensão realista.'),
].join('\n');
const recoveryFragments = geminiDiagnostics.getRecoverySubdivision(
    recoverySource,
    recoverableTruncation
);
assert.ok(Array.isArray(recoveryFragments) && recoveryFragments.length > 1);
assert.ok(
    recoveryFragments.every(
        fragment => estimateTokens(fragment) >= config.processing.minRecoveryBlockTokens
    )
);
assert.strictEqual(
    geminiDiagnostics.getRecoverySubdivision(
        recoverySource,
        recoverableTruncation,
        config.processing.maxBlockSubdivisionDepth
    ),
    null
);
const recoverableStructureFailure = new Error('estrutura inválida');
recoverableStructureFailure.code = 'PYGEM_OUTPUT_INVALID';
recoverableStructureFailure.details = {
    reason: geminiDiagnostics.GENERATION_FAILURE.INVALID_STRUCTURE,
};
assert.ok(
    geminiDiagnostics.getRecoverySubdivision(recoverySource, recoverableStructureFailure)?.length > 1
);
const recoverableFinishFailure = new Error('recitação');
recoverableFinishFailure.code = 'PYGEM_OUTPUT_INVALID';
recoverableFinishFailure.details = {
    reason: geminiDiagnostics.GENERATION_FAILURE.FINISH_REASON,
    finishReason: 'RECITATION',
};
assert.ok(
    geminiDiagnostics.getRecoverySubdivision(recoverySource, recoverableFinishFailure)?.length > 1
);
const blockedFinishFailure = new Error('segurança');
blockedFinishFailure.code = 'PYGEM_OUTPUT_INVALID';
blockedFinishFailure.details = {
    reason: geminiDiagnostics.GENERATION_FAILURE.FINISH_REASON,
    finishReason: 'SAFETY',
};
assert.strictEqual(
    geminiDiagnostics.getRecoverySubdivision(recoverySource, blockedFinishFailure),
    null
);
assert.ok(
    !require('fs').readFileSync(
        require.resolve('./src/services/geminiService'),
        'utf8'
    ).includes('[ERRO: Não foi possível reescrever o bloco')
);

const fs = require('fs');
const path = require('path');
const publicationTestRoot = fs.mkdtempSync(path.join(__dirname, 'tmp-pygem-publication-'));
try {
    const publicationOutput = path.join(publicationTestRoot, 'saida');
    const publicationSource = path.join(publicationTestRoot, 'origem');
    const firstDirectory = path.join(publicationSource, 'disciplina-a');
    const secondDirectory = path.join(publicationSource, 'disciplina-b');
    fs.mkdirSync(firstDirectory, { recursive: true });
    fs.mkdirSync(secondDirectory, { recursive: true });
    const firstSourceFile = path.join(firstDirectory, '001.md');
    const secondSourceFile = path.join(secondDirectory, '001.md');
    const failedSourceFile = path.join(firstDirectory, '002.md');
    fs.writeFileSync(firstSourceFile, '## Primeiro\n\nConteúdo original do primeiro arquivo.', 'utf8');
    fs.writeFileSync(secondSourceFile, '## Segundo\n\nConteúdo original do segundo arquivo.', 'utf8');
    fs.writeFileSync(failedSourceFile, '## Pendente\n\nConteúdo ainda não processado.', 'utf8');
    const firstOutputFile = writeRewrittenFileAtomic(
        publicationOutput,
        publicationSource,
        firstSourceFile,
        '## Primeiro\n\nConteúdo completo do primeiro arquivo.'
    );
    const secondOutputFile = writeRewrittenFileAtomic(
        publicationOutput,
        publicationSource,
        secondSourceFile,
        '## Segundo\n\nConteúdo completo do segundo arquivo.'
    );

    assert.strictEqual(
        firstOutputFile,
        path.join(publicationOutput, 'disciplina-a', '001_reescrito.md')
    );
    assert.strictEqual(
        secondOutputFile,
        path.join(publicationOutput, 'disciplina-b', '001_reescrito.md')
    );
    assert.strictEqual(fs.existsSync(firstOutputFile), true);
    assert.strictEqual(fs.existsSync(secondOutputFile), true);
    assert.notStrictEqual(firstOutputFile, secondOutputFile);
    assert.strictEqual(
        getRewrittenOutputPath(publicationOutput, publicationSource, failedSourceFile),
        path.join(publicationOutput, 'disciplina-a', '002_reescrito.md')
    );

    const incompletePublication = writeDirectoryProcessingManifest(
        publicationOutput,
        publicationSource,
        firstDirectory,
        [firstSourceFile, failedSourceFile],
        [{ filePath: firstSourceFile, outputFilePath: firstOutputFile }],
        [{ filePath: failedSourceFile, error: 'Falha controlada' }]
    );
    assert.strictEqual(incompletePublication.complete, false);
    assert.strictEqual(
        fs.existsSync(path.join(publicationOutput, 'disciplina-a', '002_reescrito.md')),
        false
    );
    assert.strictEqual(fs.existsSync(firstOutputFile), true);
    const incompleteManifest = JSON.parse(
        fs.readFileSync(incompletePublication.manifestPath, 'utf8')
    );
    assert.strictEqual(incompleteManifest.status, 'incomplete');
    assert.strictEqual(incompleteManifest.successfulFiles.length, 1);
    assert.strictEqual(incompleteManifest.failedFiles.length, 1);
    assert.match(incompleteManifest.successfulFiles[0].sourceFingerprint.sha256, /^[a-f0-9]{64}$/u);
    assert.strictEqual(
        getReusableManifestEntries(
            publicationOutput,
            publicationSource,
            firstDirectory,
            [firstSourceFile, failedSourceFile]
        ).length,
        1
    );
    fs.appendFileSync(firstSourceFile, '\nFonte alterada depois da publicação.');
    assert.strictEqual(
        getReusableManifestEntries(
            publicationOutput,
            publicationSource,
            firstDirectory,
            [firstSourceFile, failedSourceFile]
        ).length,
        0
    );
    assert.strictEqual(
        fs.readdirSync(path.dirname(firstOutputFile)).some(fileName => fileName.endsWith('.tmp')),
        false
    );

    const checkpointDirectory = path.join(publicationTestRoot, 'checkpoints');
    const checkpointOptions = {
        content: '## A\n\nTexto A.\n\n## B\n\nTexto B.',
        prompt: 'Prompt estável',
        fileName: 'arquivo-grande.md',
        blocks: ['## A\n\nTexto A.', '## B\n\nTexto B.'],
        model: 'modelo-teste',
        blockInputTokens: 900,
        directory: checkpointDirectory,
    };
    const firstCheckpoint = createRewriteCheckpoint(checkpointOptions);
    firstCheckpoint.save(1, '## A\n\nTexto reescrito A.');
    assert.strictEqual(firstCheckpoint.count(), 1);
    const resumedCheckpoint = createRewriteCheckpoint(checkpointOptions);
    assert.strictEqual(resumedCheckpoint.get(1), '## A\n\nTexto reescrito A.');
    assert.strictEqual(
        fs.readdirSync(checkpointDirectory).some(fileName => fileName.endsWith('.tmp')),
        false
    );
    const incompatibleCheckpoint = createRewriteCheckpoint({
        ...checkpointOptions,
        prompt: 'Prompt alterado',
    });
    assert.strictEqual(incompatibleCheckpoint.get(1), null);
    resumedCheckpoint.clear();
    assert.throws(
        () => getRewrittenOutputPath(
            publicationOutput,
            publicationSource,
            path.join(publicationTestRoot, 'fora.md')
        ),
        /fora do diretório de entrada/u
    );
} finally {
    fs.rmSync(publicationTestRoot, { recursive: true, force: true });
}

const performanceLogger = Object.create(PerformanceLogger.prototype);
performanceLogger.sessionId = 'test';
performanceLogger.apiCalls = [];
performanceLogger.currentFile = null;
performanceLogger.stats = {
    apiRequests: 0,
    apiErrors: 0,
    validationFailures: 0,
    truncatedResponses: 0,
    retries: 0,
    continuations: 0,
    repetitionLoops: 0,
    recoverySubdivisions: 0,
    preservedBlocks: 0,
    failedFiles: 0,
    averageTokensPerSecond: 20,
    totalDelayTime: 0,
    totalProcessingTime: 1000,
    totalBlocks: 0,
};
performanceLogger.logApiCall({
    endpoint: 'models.generateContent',
    model: 'modelo-teste',
    inputTokens: 100,
    outputTokens: 80,
    duration: 1000,
    success: true,
    finishReason: 'STOP',
    promptTokenCount: 90,
    candidatesTokenCount: 70,
    thoughtsTokenCount: 0,
    totalTokenCount: 160,
    outputLength: 280,
    requestAttempt: 2,
    budgetCallNumber: 3,
    workUnitId: 'b001.1',
    parentWorkUnitId: 'b001',
    recoveryDepth: 1,
    maxOutputTokens: 2048,
});
assert.strictEqual(performanceLogger.stats.apiRequests, 1);
assert.strictEqual(performanceLogger.stats.apiErrors, 0);
assert.strictEqual(performanceLogger.apiCalls[0].usageMetadata.thoughtsTokenCount, 0);
assert.strictEqual(performanceLogger.apiCalls[0].requestAttempt, 2);
assert.strictEqual(performanceLogger.apiCalls[0].workUnitId, 'b001.1');
assert.strictEqual(performanceLogger.apiCalls[0].maxOutputTokens, 2048);
performanceLogger.currentFile = { blocks: [], apiCalls: [] };
performanceLogger.logBlockStart(1, 2, 500, { workUnitId: 'b001' });
performanceLogger.logBlockStart(1, 2, 250, { workUnitId: 'b001.1' });
performanceLogger.logBlockEnd('b001.1', true, null, 900, { apiCallsUsed: 1 });
performanceLogger.logBlockEnd('b001', false, 'falha controlada', 0, { apiCallsUsed: 2 });
assert.strictEqual(performanceLogger.currentFile.blocks[0].success, false);
assert.strictEqual(performanceLogger.currentFile.blocks[1].success, true);
assert.strictEqual(performanceLogger.currentFile.blocks[1].apiCallsUsed, 1);
performanceLogger.currentFile = null;
performanceLogger.recordGenerationEvent('validationFailures');
assert.strictEqual(performanceLogger.stats.validationFailures, 1);
assert.ok(
    performanceLogger.generateRecommendations()
        .some(recommendation => recommendation.category === 'output-reliability')
);
assert.ok(
    !performanceLogger.generateRecommendations()
        .some(recommendation => recommendation.category === 'vertex-api')
);

console.log('Testes de política, estrutura Markdown e prompt do PYGEM: OK');
