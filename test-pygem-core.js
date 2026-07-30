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
    validateMarkdownQuality,
    validateGeneratedContent,
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

console.log('Testes de política, estrutura Markdown e prompt do PYGEM: OK');
