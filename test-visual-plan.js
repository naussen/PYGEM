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
const {
    parseVisualOptions,
    loadVisualContext,
    selectVisualTopicsForFile,
    writeVisualPlanAtomic,
} = require('./src/visual/visualContextService');
const {
    getRewritingPrompt,
    getVisualRequirementsPrompt,
} = require('./src/services/promptServiceMd');
const {
    writeDirectoryProcessingManifest,
    getReusableManifestEntries,
} = require('./src/services/fileServiceMd');
const { createRewriteCheckpoint } = require('./src/services/rewriteCheckpointService');
const {
    getCompatibleVariants,
    getStableVariantIndex,
    selectVariantFamily,
    applyVisualVariants,
} = require('./src/visual/visualVariants');

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

const selectedPlan = applyVisualVariants(compiledPlan);
const repeatedSelection = applyVisualVariants(compiledPlan);
assert.deepStrictEqual(
    repeatedSelection,
    selectedPlan,
    'A mesma semente e o mesmo plano devem produzir variantes idênticas'
);
selectedPlan.topics.forEach(topic => {
    topic.requirements.forEach(requirement => {
        assert(
            getCompatibleVariants(requirement.resource, requirement.semantic_role)
                .includes(requirement.variant_family),
            `Variante ${requirement.variant_family} deve ser compatível com ${requirement.semantic_role}`
        );
    });
});
assert.strictEqual(
    getStableVariantIndex('seed', 'topico', 'table', 'comparison', 3),
    getStableVariantIndex('seed', 'topico', 'table', 'comparison', 3),
    'Índice derivado por SHA-256 deve ser estável'
);
const comparisonVariantsAcrossSeeds = new Set(
    Array.from({ length: 24 }, (_, index) => selectVariantFamily({
        seed: `seed-${index}`,
        topicSlug: 'comparacao',
        requirement: {
            resource: 'table',
            semantic_role: 'comparison',
        },
    }))
);
assert(
    comparisonVariantsAcrossSeeds.size > 1,
    'Sementes distintas devem poder selecionar composições de tabela distintas'
);
assert.strictEqual(
    selectVariantFamily({
        seed: 'qualquer',
        topicSlug: 'regra',
        requirement: {
            resource: 'highlight',
            semantic_role: 'rule',
            variant_family: 'keyword-rule',
        },
    }),
    'keyword-rule',
    'Variante explícita semanticamente válida deve ser preservada'
);
assert.throws(
    () => selectVariantFamily({
        seed: 'qualquer',
        topicSlug: 'decisao',
        requirement: {
            resource: 'mermaid',
            semantic_role: 'decision_flow',
            variant_family: 'linear-stages',
        },
    }),
    error => error.code === 'PYGEM_VISUAL_VARIANT_ROLE_MISMATCH',
    'Variante incompatível com o papel semântico deve falhar antes da geração'
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

assert.deepStrictEqual(
    parseVisualOptions([], {}),
    {
        visualGuidePath: null,
        visualPlanPath: null,
        discipline: null,
        guideId: null,
        diversificationSeed: null,
    },
    'Fluxo sem guia deve permanecer compatível'
);
assert.strictEqual(
    parseVisualOptions(
        ['--visual-plan', 'cli.json'],
        { PYGEM_VISUAL_PLAN: 'env.json' }
    ).visualPlanPath,
    'cli.json',
    'Opção de CLI deve prevalecer sobre variável de ambiente'
);
assert.throws(
    () => parseVisualOptions(
        ['--visual-guide', 'guia.md', '--visual-plan', 'plano.json', '--visual-discipline', 'Auditoria'],
        {}
    ),
    error => error.code === 'PYGEM_VISUAL_INPUT_CONFLICT',
    'Guia e plano não podem ser usados simultaneamente'
);
assert.throws(
    () => parseVisualOptions(['--visual-guide', 'guia.md'], {}),
    error => error.code === 'PYGEM_VISUAL_DISCIPLINE_REQUIRED',
    'Compilação integrada do guia exige disciplina explícita'
);

const groupedPlan = {
    schema_version: 1,
    discipline: 'Auditoria',
    guide_id: 'auditoria-visual-v1',
    guide_sha256: '0'.repeat(64),
    diversification_seed: 'auditoria-v1',
    topics: [
        {
            canonical_title: 'Independência',
            topic_slug: 'independencia',
            requirements: [],
        },
        {
            canonical_title: 'Rotação dos responsáveis técnicos (RT)',
            topic_slug: 'rotacao-dos-responsaveis-tecnicos-rt',
            requirements: [],
        },
        {
            canonical_title: 'Eventos subsequentes',
            topic_slug: 'eventos-subsequentes',
            requirements: [],
        },
    ],
};
const groupedTopics = selectVisualTopicsForFile(
    '005_Auditoria.md',
    '@@ IN DE PEN DÊN CIA\n\nRO TA ÇÃO DOS RE S PON SÁVEIS TÉC NICOS (RT)\nTexto.',
    groupedPlan
);
assert.deepStrictEqual(
    groupedTopics.map(topic => topic.topic_slug),
    ['independencia', 'rotacao-dos-responsaveis-tecnicos-rt'],
    'Seleção deve reconhecer títulos fragmentados e vários tópicos no mesmo arquivo'
);
assert.throws(
    () => selectVisualTopicsForFile('999_Auditoria.md', '@@ Assunto sem plano', groupedPlan),
    error => error.code === 'PYGEM_VISUAL_TOPIC_NOT_MATCHED',
    'Arquivo sem correspondência não pode seguir silenciosamente com plano ativo'
);

const visualPrompt = getRewritingPrompt({ visualTopics: [compiledPlan.topics[0]] });
assert.match(visualPrompt, /CONTRATO VISUAL DESTE ARQUIVO/u);
assert.match(visualPrompt, new RegExp(compiledPlan.topics[0].topic_slug, 'u'));
assert.doesNotMatch(visualPrompt, new RegExp(compiledPlan.topics[1].topic_slug, 'u'));
assert.doesNotMatch(getRewritingPrompt(), /CONTRATO VISUAL DESTE ARQUIVO/u);
assert.match(
    getVisualRequirementsPrompt([compiledPlan.topics[0]]),
    /não substitua tabela por Mermaid/u,
    'Prompt deve proibir troca do tipo de ferramenta'
);
const selectedVisualPrompt = getVisualRequirementsPrompt([selectedPlan.topics[0]]);
assert.match(selectedVisualPrompt, /variante=/u);
assert.match(selectedVisualPrompt, /estrutura:/u);
assert.match(selectedVisualPrompt, /Não copie redação, cores, geometria/u);

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
    assert(
        JSON.parse(fs.readFileSync(cliOutputPath, 'utf8')).topics
            .every(topic => topic.requirements.every(requirement => requirement.variant_family)),
        'CLI deve persistir todas as variantes determinísticas selecionadas'
    );
    const loadedPlan = loadVisualContext({
        visualGuidePath: null,
        visualPlanPath: cliOutputPath,
    });
    assert.strictEqual(loadedPlan.inputType, 'plan');
    assert.strictEqual(loadedPlan.plan.topics.length, 3);

    const persistedDirectory = path.join(cliDirectory, 'saida');
    const persistedPlanPath = writeVisualPlanAtomic(persistedDirectory, loadedPlan.plan);
    assert.strictEqual(path.basename(persistedPlanPath), '_visual-plan.json');
    assert.strictEqual(
        validateVisualPlan(JSON.parse(fs.readFileSync(persistedPlanPath, 'utf8'))).topics.length,
        3
    );
} finally {
    fs.rmSync(cliDirectory, { recursive: true, force: true });
}

const reuseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pygem-visual-reuse-'));
try {
    const inputDirectory = path.join(reuseDirectory, 'entrada');
    const outputDirectory = path.join(reuseDirectory, 'saida');
    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    const sourcePath = path.join(inputDirectory, '010_Auditoria.md');
    const outputPath = path.join(outputDirectory, '010_Auditoria_reescrito.md');
    fs.writeFileSync(sourcePath, '@@ Planejamento\nFonte.', 'utf8');
    fs.writeFileSync(outputPath, '@@ Planejamento\nSaída.', 'utf8');
    writeDirectoryProcessingManifest(
        outputDirectory,
        inputDirectory,
        inputDirectory,
        [sourcePath],
        [{ filePath: sourcePath, outputFilePath: outputPath }],
        [],
        { generationFingerprint: 'contexto-a' }
    );
    assert.strictEqual(
        getReusableManifestEntries(
            outputDirectory,
            inputDirectory,
            inputDirectory,
            [sourcePath],
            { generationFingerprint: 'contexto-a' }
        ).length,
        1,
        'Saída pode ser reutilizada com o mesmo contexto de geração'
    );
    assert.strictEqual(
        getReusableManifestEntries(
            outputDirectory,
            inputDirectory,
            inputDirectory,
            [sourcePath],
            { generationFingerprint: 'contexto-b' }
        ).length,
        0,
        'Mudança do plano visual deve invalidar reutilização do arquivo publicado'
    );

    const checkpointDirectory = path.join(reuseDirectory, 'checkpoints');
    const checkpointA = createRewriteCheckpoint({
        content: 'Fonte',
        prompt: 'Prompt',
        fileName: '010.md',
        blocks: ['Fonte'],
        model: 'modelo',
        blockInputTokens: 100,
        generationSignature: { visualPlanHash: 'a' },
        directory: checkpointDirectory,
    });
    const checkpointB = createRewriteCheckpoint({
        content: 'Fonte',
        prompt: 'Prompt',
        fileName: '010.md',
        blocks: ['Fonte'],
        model: 'modelo',
        blockInputTokens: 100,
        generationSignature: { visualPlanHash: 'b' },
        directory: checkpointDirectory,
    });
    assert.notStrictEqual(
        checkpointA.filePath,
        checkpointB.filePath,
        'Mudança do hash visual deve invalidar checkpoint de blocos'
    );
} finally {
    fs.rmSync(reuseDirectory, { recursive: true, force: true });
}

console.log('Testes do contrato e compilador de manifesto visual: OK');
