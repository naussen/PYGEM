const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateVisualManifest } = require('../src/visual/visualManifest');
const { validateVisualPlan } = require('../src/visual/visualPlanValidator');
const { applyVisualVariants } = require('../src/visual/visualVariants');
const { validateVisualCompliance } = require('../src/visual/visualComplianceValidator');

const fixtures = path.join(__dirname, 'fixtures', 'visual');
const readJson = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));

['010', '022', '023'].forEach(index => {
    const manifest = readJson(`${index}-manifest.json`);
    assert.doesNotThrow(() => validateVisualManifest(manifest), `${index}: manifesto válido`);
    assert(fs.existsSync(path.join(fixtures, `${index}-source.md`)));
    assert(fs.existsSync(path.join(fixtures, `${index}-output.md`)));
    manifest.topics.forEach(topic => {
        topic.selected_variants.forEach(variant => {
            const plan = {
                    schema_version: 1,
                    discipline: 'Auditoria',
                    guide_id: 'fixture',
                    guide_sha256: '0'.repeat(64),
                    diversification_seed: 'fixture',
                    topics: [{
                        canonical_title: topic.topic_slug,
                        topic_slug: topic.topic_slug,
                        requirements: [{
                            resource: variant.resource,
                            semantic_role: variant.semantic_role,
                            required: true,
                            minimum: 1,
                            maximum: 1,
                            variant_family: variant.variant_family,
                        }],
                    }],
                };
            const first = applyVisualVariants(plan).topics[0].requirements[0].variant_family;
            const second = applyVisualVariants(plan).topics[0].requirements[0].variant_family;
            assert.strictEqual(first, second, `${index}: variante deve ser determinística`);
            assert.strictEqual(
                first,
                variant.variant_family,
                `${index}: variante explícita deve ser preservada`
            );
        });
    });
});

const invalidManifest = readJson('022-manifest.json');
invalidManifest.topics[0].topic_slug = 'slug--fragmentado';
assert.throws(
    () => validateVisualManifest(invalidManifest),
    error => error.code === 'PYGEM_VISUAL_MANIFEST_INVALID'
        && error.issues.some(issue => issue.code === 'TOPIC_SLUG_INVALID')
);

const missingTable = readJson('022-manifest.json');
const source = fs.readFileSync(path.join(fixtures, '022-output.md'), 'utf8')
    .replace(/\| Tipo \| Base \|[\s\S]*?\| Limpa \| Evidência suficiente \|\n\n/u, '');
const tableTopic = missingTable.topics[0];
assert(
    validateVisualCompliance(source, { visualTopics: [tableTopic] }).issues
        .some(issue => issue.resource === 'table'),
    '022: ausência de tabela obrigatória deve ser detectada'
);

const wrongSection = fs.readFileSync(path.join(fixtures, '022-output.md'), 'utf8')
    .replace('### Decisão', '### Outra seção');
assert(
    validateVisualCompliance(wrongSection, { visualTopics: [tableTopic] }).issues
        .some(issue => issue.code === 'VISUAL_TARGET_SECTION_MISSING'),
    '022: recurso na seção errada deve ser bloqueado'
);

const maliciousMermaid = fs.readFileSync(path.join(fixtures, '010-output.md'), 'utf8')
    .replace('A[Objetivo] --> B[Plano]', 'A[Objetivo] -->');
assert(
    validateVisualCompliance(maliciousMermaid, { visualTopics: [readJson('010-manifest.json').topics[0]] }).issues
        .some(issue => issue.code === 'VISUAL_MERMAID_INVALID'),
    '010: Mermaid inválido deve ser bloqueado'
);

const duplicatedPlan = readJson('visual-plan.valid.json');
duplicatedPlan.topics.push({ ...duplicatedPlan.topics[0], canonical_title: 'Duplicado' });
assert.throws(
    () => validateVisualPlan(duplicatedPlan),
    error => error.issues.some(issue => issue.code === 'TOPIC_SLUG_DUPLICATE'),
    'Plano duplicado deve ser rejeitado'
);

console.log('test-visual-fixtures: ok');
