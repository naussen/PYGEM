const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    VisualPlanValidationError,
    collectVisualPlanIssues,
    validateVisualPlan,
} = require('./src/visual/visualPlanValidator');
const {
    VisualGuideCompilationError,
    sha256,
    canonicalizeTitle,
    compileVisualGuide,
} = require('./src/visual/visualGuideCompiler');
const {
    VisualManifestValidationError,
    createVisualManifest,
    validateVisualManifest,
    writeVisualManifestAtomic,
} = require('./src/visual/visualManifest');
const {
    parseArgs,
    getDefaultOutputPath,
    main: compileGuideCli,
} = require('./src/visual/compileVisualGuideCli');

const fixtures = path.join(__dirname, 'test', 'fixtures', 'visual');
const guide = fs.readFileSync(path.join(fixtures, 'guide.visual.md'), 'utf8');
const validPlanFixture = JSON.parse(
    fs.readFileSync(path.join(fixtures, 'visual-plan.valid.json'), 'utf8')
);
const invalidPlanFixture = JSON.parse(
    fs.readFileSync(path.join(fixtures, 'visual-plan.invalid.json'), 'utf8')
);
JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'visual', 'schemas', 'visual-plan.schema.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'visual', 'schemas', 'visual-manifest.schema.json'), 'utf8'));

assert.strictEqual(
    canonicalizeTitle('RELATÓRIO DE AUDITORIA (NBC TA 700)'),
    'Relatório de auditoria (NBC TA 700)',
    'Título deve usar capitalização editorial e preservar siglas'
);

const compiledPlan = compileVisualGuide(guide, {
    discipline: 'Auditoria',
    guideId: 'auditoria-visual-v1',
    diversificationSeed: 'auditoria-piloto-v1',
});
assert.strictEqual(compiledPlan.topics.length, 3, 'Sumário não deve virar tópico de conteúdo');
assert.strictEqual(compiledPlan.guide_sha256, sha256(guide), 'Hash deve representar o relatório literal');
assert.strictEqual(compiledPlan.topics[0].source_index, '010', 'Índice explícito deve ser transportado');
assert.deepStrictEqual(
    compiledPlan.topics[0].requirements.map(item => item.resource).sort(),
    ['highlight', 'mermaid'],
    'Planejamento deve exigir fluxo e realce'
);
assert.deepStrictEqual(
    compiledPlan.topics[1].requirements.map(item => item.resource).sort(),
    ['highlight', 'mermaid', 'table'],
    'Relatório deve exigir tabela, Mermaid e realce'
);
assert.strictEqual(
    compiledPlan.topics[1].requirements.find(item => item.resource === 'mermaid').semantic_role,
    'decision_flow',
    'Papel do Mermaid deve ser inferido independentemente dos demais recursos do tópico'
);
assert.strictEqual(
    compiledPlan.topics[1].requirements.find(item => item.resource === 'table').semantic_role,
    'comparison',
    'Papel da tabela não deve herdar a decisão destinada ao Mermaid'
);
assert.strictEqual(
    compiledPlan.topics[1].requirements.find(item => item.resource === 'highlight').semantic_role,
    'critical_order',
    'Realce deve identificar a regra de ordenação crítica'
);
assert.deepStrictEqual(
    compiledPlan.topics[2].requirements.map(item => item.resource).sort(),
    ['highlight', 'mnemonic', 'table'],
    'Recomendação deve prevalecer e não copiar o diagrama descrito apenas como original'
);

assert.strictEqual(validateVisualPlan(validPlanFixture), validPlanFixture);
assert.throws(
    () => validateVisualPlan(invalidPlanFixture),
    error => error instanceof VisualPlanValidationError
        && error.issues.some(issue => issue.code === 'TOPIC_SLUG_DUPLICATE'),
    'Slug duplicado deve ser rejeitado'
);
assert.throws(
    () => validateVisualPlan(validPlanFixture, { expectedGuideHash: 'f'.repeat(64) }),
    error => error instanceof VisualPlanValidationError
        && error.issues.some(issue => issue.code === 'GUIDE_HASH_MISMATCH'),
    'Plano de outro relatório deve ser rejeitado'
);

const requiredWithZero = JSON.parse(JSON.stringify(validPlanFixture));
requiredWithZero.topics[0].requirements[0].minimum = 0;
assert(
    collectVisualPlanIssues(requiredWithZero)
        .some(issue => issue.code === 'REQUIRED_WITH_ZERO_MINIMUM'),
    'Recurso obrigatório não pode ter mínimo zero'
);
const incompatibleVariant = JSON.parse(JSON.stringify(validPlanFixture));
incompatibleVariant.topics[0].requirements[0].variant_family = 'criteria-as-rows';
assert(
    collectVisualPlanIssues(incompatibleVariant)
        .some(issue => issue.code === 'VARIANT_RESOURCE_MISMATCH'),
    'Variante de tabela não pode ser atribuída a Mermaid'
);

assert.throws(
    () => compileVisualGuide('# Sem tópicos H3', { discipline: 'Auditoria' }),
    error => error instanceof VisualGuideCompilationError
        && error.code === 'PYGEM_VISUAL_GUIDE_WITHOUT_TOPICS',
    'Relatório sem tópicos deve falhar de forma explícita'
);
assert.throws(
    () => compileVisualGuide(guide, {}),
    error => error instanceof VisualGuideCompilationError
        && error.code === 'PYGEM_VISUAL_DISCIPLINE_REQUIRED',
    'Disciplina deve ser obrigatória na compilação'
);
assert.throws(
    () => compileVisualGuide(`### Tópico\n${'A'.repeat(20001)}`, { discipline: 'Auditoria' }),
    error => error instanceof VisualGuideCompilationError
        && error.code === 'PYGEM_VISUAL_GUIDE_LINE_TOO_LONG',
    'Linha patológica deve ser rejeitada antes da compilação'
);

assert.deepStrictEqual(
    parseArgs([
        'guia.visual.md',
        '--discipline',
        'Auditoria',
        '--guide-id=auditoria-visual-v1',
        '--seed',
        'piloto-v1',
    ]),
    {
        inputPath: 'guia.visual.md',
        outputPath: null,
        discipline: 'Auditoria',
        guideId: 'auditoria-visual-v1',
        diversificationSeed: 'piloto-v1',
    },
    'CLI deve aceitar valores separados e inline'
);
assert.strictEqual(
    getDefaultOutputPath(path.join('dados', 'auditoria.visual.md')),
    path.join('dados', 'auditoria.visual-plan.json'),
    'Nome padrão não deve duplicar o sufixo visual'
);

const completeManifest = createVisualManifest({
    sourceFile: 'C:\\fontes\\010_Auditoria.md',
    outputFile: 'C:\\saidas\\010_Auditoria_reescrito.md',
    sourceContent: '## Planejamento\nFonte.',
    outputContent: '## Planejamento\nSaída.',
    visualPlan: compiledPlan,
    topicResults: [
        {
            topicSlug: compiledPlan.topics[0].topic_slug,
            observedResources: [
                { resource: 'mermaid', count: 1 },
                { resource: 'highlight', count: 1 },
            ],
        },
        {
            topicSlug: compiledPlan.topics[1].topic_slug,
            observedResources: [
                { resource: 'table', count: 1 },
                { resource: 'mermaid', count: 1 },
                { resource: 'highlight', count: 1 },
            ],
        },
    ],
});
assert.strictEqual(completeManifest.status, 'complete');
assert.strictEqual(completeManifest.source_file, '010_Auditoria.md');
assert.strictEqual(completeManifest.topics.length, 2, 'Um arquivo pode agrupar vários tópicos visuais');
assert(!JSON.stringify(completeManifest).includes('C:\\fontes'), 'Manifesto não deve expor caminho absoluto');
assert.strictEqual(validateVisualManifest(completeManifest), completeManifest);

const invalidCompleteManifest = JSON.parse(JSON.stringify(completeManifest));
invalidCompleteManifest.topics[0].violations.push({ code: 'MISSING_TABLE', message: 'Tabela ausente' });
assert.throws(
    () => validateVisualManifest(invalidCompleteManifest),
    error => error instanceof VisualManifestValidationError
        && error.issues.some(issue => issue.code === 'COMPLETE_WITH_VIOLATIONS'),
    'Status completo com violações deve ser rejeitado'
);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pygem-visual-plan-'));
try {
    const manifestPath = path.join(temporaryDirectory, '010.visual-manifest.json');
    writeVisualManifestAtomic(manifestPath, completeManifest);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), completeManifest);
    assert.strictEqual(
        fs.readdirSync(temporaryDirectory).filter(name => name.endsWith('.tmp')).length,
        0,
        'Gravação atômica não deve deixar arquivo temporário'
    );
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

const cliDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pygem-visual-cli-'));
try {
    const cliOutputPath = path.join(cliDirectory, 'compiled.visual-plan.json');
    const cliResult = compileGuideCli([
        path.join(fixtures, 'guide.visual.md'),
        '--discipline',
        'Auditoria',
        '--output',
        cliOutputPath,
    ]);
    assert.strictEqual(cliResult.outputPath, cliOutputPath);
    assert.strictEqual(
        validateVisualPlan(JSON.parse(fs.readFileSync(cliOutputPath, 'utf8'))).topics.length,
        3,
        'CLI deve publicar somente um plano integral e validado'
    );
} finally {
    fs.rmSync(cliDirectory, { recursive: true, force: true });
}

console.log('Testes do contrato e compilador de manifesto visual: OK');
