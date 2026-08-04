const assert = require('assert');
const config = require('./src/config/runtime');
const {
    isOutputTooShort,
    isOutputTooLong,
    normalizeInlineTopicMarkers,
    getBlockPrompt,
} = require('./src/utils/contentPreprocessor');
const {
    splitContentIntoBlocks,
    estimateTokens,
} = require('./src/services/tokenService');
const { getRewritingPrompt } = require('./src/services/promptServiceMd');
const {
    getRewrittenOutputPath,
    writeRewrittenFileAtomic,
    writeDirectoryProcessingManifest,
} = require('./src/services/fileServiceMd');
const { diagnostics: geminiDiagnostics } = require('./src/services/geminiService');
const PerformanceLogger = require('./src/services/performanceLogger');
const {
    validateMarkdownQuality,
    validateGeneratedContent,
    validateSourceHeadingCoverage,
} = require('./src/utils/validation');

assert.strictEqual(isOutputTooShort('a'.repeat(100), 'a'.repeat(80), 0.75), false);
assert.strictEqual(isOutputTooLong('a'.repeat(100), 'a'.repeat(301), 3), true);
assert.strictEqual(isOutputTooLong('a'.repeat(100), 'a'.repeat(300), 3), false);
assert.strictEqual(
    normalizeInlineTopicMarkers(
        '@@@ ## Empresa e Empresário\n\nTexto.\n\n@@@\n## Registro\n\n@@@ ### Subtítulo'
    ),
    '@@@\n## Empresa e Empresário\n\nTexto.\n\n@@@\n## Registro\n\n@@@ ### Subtítulo'
);
assert.match(getBlockPrompt('Prompt', 2, 3), /NÃO repita nem invente o marcador @@@/u);
const blocksWithResidualTail = splitContentIntoBlocks(
    `${'conteúdo longo '.repeat(130)}\n# Continuação\n${'final '.repeat(10)}`,
    600
);
assert.strictEqual(blocksWithResidualTail.length, 1);
assert.ok(estimateTokens(blocksWithResidualTail[0]) <= 600);
assert.ok(config.outputPolicy.maxOutputRatio >= 1);
assert.ok(config.retry.maxGenerationAttempts >= 1);
assert.ok(config.retry.continuationMinInputTokens >= 1);
assert.ok(config.processing.singlePassMaxInputTokens < 5000);
assert.ok(config.processing.blockInputTokens <= config.processing.singlePassMaxInputTokens);
assert.ok(config.processing.minRecoveryBlockTokens < config.processing.blockInputTokens);
assert.ok(config.generationConfig.thinkingConfig.thinkingBudget >= 0);
assert.strictEqual(config.generationConfig.thinkingConfig.includeThoughts, false);
assert.match(getRewritingPrompt(), /RECURSOS DIDÁTICOS \(USE COM CRITÉRIO\)/u);
assert.match(getRewritingPrompt(), /capitalização editorial/u);

const uppercaseHeading = validateMarkdownQuality('## AUDITORIA INTERNA (NBC TI 01)\n\nConteúdo.');
assert.ok(
    !uppercaseHeading.valid
    && uppercaseHeading.issues.some(issue => issue.includes('predominantemente em maiúsculas'))
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
    validateMarkdownQuality(
        '## Administração pública\n\n### Princípios\n\nConteúdo.'
    ).valid,
    true
);

assert.ok(
    geminiDiagnostics.calculateMaxOutputTokens('conteúdo curto')
    >= config.outputPolicy.minOutputTokens
);
assert.match(
    geminiDiagnostics.getRetryInstruction({
        reason: geminiDiagnostics.GENERATION_FAILURE.MAX_TOKENS,
    }),
    /truncada/u
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
    geminiDiagnostics.getRecoverySubdivision(recoverySource, recoverableTruncation, 1),
    null
);
const nonRecoverableFailure = new Error('estrutura inválida');
nonRecoverableFailure.code = 'PYGEM_OUTPUT_INVALID';
nonRecoverableFailure.details = {
    reason: geminiDiagnostics.GENERATION_FAILURE.INVALID_STRUCTURE,
};
assert.strictEqual(
    geminiDiagnostics.getRecoverySubdivision(recoverySource, nonRecoverableFailure),
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
    assert.strictEqual(
        fs.readdirSync(path.dirname(firstOutputFile)).some(fileName => fileName.endsWith('.tmp')),
        false
    );
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
    failedFiles: 0,
    averageTokensPerSecond: 20,
    totalDelayTime: 0,
    totalProcessingTime: 1000,
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
});
assert.strictEqual(performanceLogger.stats.apiRequests, 1);
assert.strictEqual(performanceLogger.stats.apiErrors, 0);
assert.strictEqual(performanceLogger.apiCalls[0].usageMetadata.thoughtsTokenCount, 0);
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
