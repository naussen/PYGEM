const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, promptMissingOptions } = require('../src/visual/visualRetrofitCli');
const {
    START_SENTINEL,
    END_SENTINEL,
    collectMissingRequirements,
    extractVisualFragment,
    validateVisualFragment,
    applyInsertions,
    isSubsequence,
    runVisualRetrofit,
} = require('../src/visual/visualRetrofitService');

assert.deepStrictEqual(
    parseArgs([
        '--input-dir', 'entrada',
        '--visual-dir=visuais',
        '--output-dir', 'saida',
        '--discipline', 'Contabilidade',
        '--dry-run',
    ]),
    {
        inputDirectory: 'entrada',
        visualDirectory: 'visuais',
        outputDirectory: 'saida',
        discipline: 'Contabilidade',
        dryRun: true,
    }
);

const answers = ['entrada', 'visuais', 'saida', 'Contabilidade'];
assert.deepStrictEqual(
    promptMissingOptions({
        inputDirectory: null,
        visualDirectory: null,
        outputDirectory: null,
        discipline: null,
        dryRun: false,
    }, () => answers.shift()),
    {
        inputDirectory: 'entrada',
        visualDirectory: 'visuais',
        outputDirectory: 'saida',
        discipline: 'Contabilidade',
        dryRun: false,
    }
);

const tableRequirement = {
    resource: 'table',
    semantic_role: 'comparison',
    minimum: 1,
    maximum: 2,
    variant_family: 'criteria-as-rows',
};
const visualTopics = [{
    canonical_title: 'Conceitos básicos',
    topic_slug: 'conceitos-basicos',
    requirements: [tableRequirement],
}];
assert.strictEqual(
    collectMissingRequirements('## Conceitos\n\nTexto.', visualTopics).missing.length,
    1
);
assert.strictEqual(
    collectMissingRequirements('| A | B |\n| --- | --- |\n| C | D |', visualTopics).missing.length,
    0
);

const tableResponse = [
    START_SENTINEL,
    '| Conceito | Finalidade |',
    '| --- | --- |',
    '| Patrimônio | Objeto da contabilidade |',
    END_SENTINEL,
].join('\n');
const tableFragment = extractVisualFragment(tableResponse);
assert.strictEqual(
    validateVisualFragment(
        tableFragment,
        tableRequirement,
        'O patrimônio é o objeto da contabilidade.'
    ),
    tableFragment
);
assert.throws(
    () => validateVisualFragment(
        '## Título proibido\n\n| A | B |\n| --- | --- |\n| C | D |',
        tableRequirement,
        'A B C D'
    ),
    /títulos/u
);
assert.throws(
    () => validateVisualFragment(
        '| A | B |\n| --- | --- |\n| Link | javascript:alert(1) |',
        tableRequirement,
        'A B Link'
    ),
    /proibido/u,
    'Fragmentos com protocolo executável devem ser rejeitados'
);
assert.throws(
    () => validateVisualFragment(
        '| Regra | Prazo |\n| --- | --- |\n| Revisão | 99 dias |',
        tableRequirement,
        'A revisão possui prazo definido na fonte oficial.',
    ),
    /numeral ausente/u,
    'Fragmentos não podem introduzir numerais ausentes na fonte'
);

const source = '@@ Conceitos básicos\n\nTexto original.\n\n## Flashcards\n\nQuestão.';
const enriched = applyInsertions(source, [{ offset: source.indexOf('## Flashcards'), fragment: tableFragment }]);
assert(isSubsequence(source, enriched));
assert(enriched.includes(tableFragment));

async function runIntegrationTest() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pygem-visual-retrofit-'));
    try {
    const inputDirectory = path.join(temporaryRoot, 'entrada');
    const visualDirectory = path.join(temporaryRoot, 'visuais');
    const outputDirectory = path.join(temporaryRoot, 'saida');
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.mkdirSync(visualDirectory, { recursive: true });
    const mappedPath = path.join(inputDirectory, '001_conceitos_reescrito.md');
    const unmappedPath = path.join(inputDirectory, '002_sem-mapa_reescrito.md');
    const failedPath = path.join(inputDirectory, '003_falha-visual_reescrito.md');
    const mappedSource = [
        '@@ Conceitos básicos',
        '',
        'O patrimônio é o objeto da contabilidade e representa bens, direitos e obrigações.',
        '',
        '## Revisão',
        '',
        'A contabilidade registra e apresenta informações patrimoniais.',
    ].join('\n');
    const unmappedBytes = Buffer.from('\uFEFF@@ Material sem mapa\r\n\r\nConteúdo preservado.', 'utf8');
    fs.writeFileSync(mappedPath, mappedSource, 'utf8');
    fs.writeFileSync(unmappedPath, unmappedBytes);
    fs.writeFileSync(failedPath, '@@ Falha visual\n\nConteúdo que deve ser preservado.', 'utf8');
    fs.writeFileSync(
        path.join(visualDirectory, '001_prompt-visual.md'),
        '@@ ### **Conceitos básicos**\n\nUsar uma tabela comparativa.',
        'utf8'
    );
    fs.writeFileSync(
        path.join(visualDirectory, '003_prompt-visual.md'),
        '@@ ### **Falha visual**\n\nUsar uma tabela comparativa.',
        'utf8'
    );

        const report = await runVisualRetrofit({
        inputDirectory,
        visualDirectory,
        outputDirectory,
        discipline: 'Contabilidade',
        generator: async (_prompt, metadata) => (
            path.basename(metadata.filePath).startsWith('003_')
                ? `${START_SENTINEL}\n## Título proibido\n${END_SENTINEL}`
                : tableResponse
        ),
    });
    assert.strictEqual(report.summary.enriched, 1);
    assert.strictEqual(report.summary.copied, 1);
    assert.strictEqual(report.summary['failed-copied'], 1);
        assert.strictEqual(report.pairing.missing_visual_indexes[0], '002');
        assert.strictEqual(
        fs.readFileSync(path.join(inputDirectory, '001_conceitos_reescrito.md'), 'utf8'),
        mappedSource,
        'Fonte mapeada deve permanecer intacta'
    );
    assert.deepStrictEqual(
        fs.readFileSync(path.join(outputDirectory, '002_sem-mapa_reescrito.md')),
        unmappedBytes,
        'Arquivo sem mapa deve ser copiado byte a byte'
    );
    assert.strictEqual(
        fs.readFileSync(path.join(outputDirectory, '003_falha-visual_reescrito.md'), 'utf8'),
        '@@ Falha visual\n\nConteúdo que deve ser preservado.',
        'Falha de fragmento deve publicar somente uma cópia intacta'
    );
        const mappedOutput = fs.readFileSync(
        path.join(outputDirectory, '001_conceitos_reescrito.md'),
        'utf8'
    );
        assert(isSubsequence(mappedSource, mappedOutput));
        assert(mappedOutput.includes('| Conceito | Finalidade |'));
        assert(fs.existsSync(path.join(outputDirectory, '_visual-retrofit-report.json')));
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

runIntegrationTest()
    .then(() => console.log('test-visual-retrofit: ok'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
