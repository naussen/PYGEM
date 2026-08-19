const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    RESOURCES,
    SEMANTIC_ROLES,
    VARIANT_FAMILIES,
    VARIANTS_BY_RESOURCE,
    collectVisualRequirementIssues,
    validateVisualPlan,
} = require('./visualPlanValidator');

const VISUAL_MANIFEST_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANIFEST_KEYS = new Set([
    'schema_version',
    'status',
    'source_file',
    'output_file',
    'source_sha256',
    'output_sha256',
    'visual_plan_sha256',
    'topics',
]);
const TOPIC_KEYS = new Set([
    'topic_slug',
    'selected_variants',
    'requirements',
    'observed_resources',
    'violations',
]);
const VARIANT_KEYS = new Set(['resource', 'semantic_role', 'variant_family']);
const VIOLATION_KEYS = new Set(['code', 'message', 'requirement_index']);
const MAX_MANIFEST_TOPICS = 500;
const MAX_TOPIC_RESOURCES = 16;
const MAX_TOPIC_VIOLATIONS = 64;

class VisualManifestValidationError extends Error {
    constructor(issues) {
        super(`Manifesto visual inválido: ${issues.map(issue => issue.message).join('; ')}`);
        this.name = 'VisualManifestValidationError';
        this.code = 'PYGEM_VISUAL_MANIFEST_INVALID';
        this.issues = issues;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256Buffer(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function addUnknownKeyIssues(value, allowedKeys, objectPath, issues) {
    Object.keys(value).forEach(key => {
        if (!allowedKeys.has(key)) {
            issues.push({
                code: 'UNKNOWN_FIELD',
                path: `${objectPath}.${key}`,
                message: `${objectPath}.${key} não é permitido pelo manifesto visual v1`,
            });
        }
    });
}

function validateNamedFile(manifest, field, issues) {
    const value = manifest[field];
    if (typeof value !== 'string' || !value.trim() || path.basename(value) !== value) {
        issues.push({
            code: 'FILE_NAME_INVALID',
            path: `$.${field}`,
            message: `$.${field} deve conter somente o nome do arquivo`,
        });
    } else if (value.length > 255) {
        issues.push({
            code: 'FILE_NAME_TOO_LONG',
            path: `$.${field}`,
            message: `$.${field} excede 255 caracteres`,
        });
    }
}

function validateVariant(variant, variantPath, issues) {
    if (!isPlainObject(variant)) {
        issues.push({ code: 'VARIANT_INVALID', path: variantPath, message: `${variantPath} deve ser objeto` });
        return;
    }
    addUnknownKeyIssues(variant, VARIANT_KEYS, variantPath, issues);
    VARIANT_KEYS.forEach(field => {
        if (typeof variant[field] !== 'string' || !variant[field].trim()) {
            issues.push({
                code: 'VARIANT_FIELD_INVALID',
                path: `${variantPath}.${field}`,
                message: `${variantPath}.${field} deve ser string não vazia`,
            });
        }
    });
    if (typeof variant.resource === 'string' && !RESOURCES.has(variant.resource)) {
        issues.push({
            code: 'VARIANT_RESOURCE_INVALID',
            path: `${variantPath}.resource`,
            message: `${variantPath}.resource possui valor desconhecido`,
        });
    }
    if (typeof variant.semantic_role === 'string' && !SEMANTIC_ROLES.has(variant.semantic_role)) {
        issues.push({
            code: 'VARIANT_ROLE_INVALID',
            path: `${variantPath}.semantic_role`,
            message: `${variantPath}.semantic_role possui valor desconhecido`,
        });
    }
    if (typeof variant.variant_family === 'string' && !VARIANT_FAMILIES.has(variant.variant_family)) {
        issues.push({
            code: 'VARIANT_FAMILY_INVALID',
            path: `${variantPath}.variant_family`,
            message: `${variantPath}.variant_family possui valor desconhecido`,
        });
    } else if (
        typeof variant.resource === 'string'
        && typeof variant.variant_family === 'string'
        && RESOURCES.has(variant.resource)
        && !VARIANTS_BY_RESOURCE.get(variant.resource)?.has(variant.variant_family)
    ) {
        issues.push({
            code: 'VARIANT_RESOURCE_MISMATCH',
            path: `${variantPath}.variant_family`,
            message: `${variantPath}.variant_family não é compatível com ${variant.resource}`,
        });
    }
}

function validateViolation(violation, violationPath, issues) {
    if (!isPlainObject(violation)) {
        issues.push({ code: 'VIOLATION_INVALID', path: violationPath, message: `${violationPath} deve ser objeto` });
        return;
    }
    addUnknownKeyIssues(violation, VIOLATION_KEYS, violationPath, issues);
    ['code', 'message'].forEach(field => {
        if (typeof violation[field] !== 'string' || !violation[field].trim()) {
            issues.push({
                code: 'VIOLATION_FIELD_INVALID',
                path: `${violationPath}.${field}`,
                message: `${violationPath}.${field} deve ser string não vazia`,
            });
        }
    });
    if (
        Object.hasOwn(violation, 'requirement_index')
        && (!Number.isInteger(violation.requirement_index) || violation.requirement_index < 0)
    ) {
        issues.push({
            code: 'VIOLATION_INDEX_INVALID',
            path: `${violationPath}.requirement_index`,
            message: `${violationPath}.requirement_index deve ser inteiro não negativo`,
        });
    }
}

function collectVisualManifestIssues(manifest) {
    const issues = [];
    if (!isPlainObject(manifest)) {
        return [{ code: 'MANIFEST_INVALID', path: '$', message: 'O manifesto deve ser um objeto' }];
    }

    addUnknownKeyIssues(manifest, MANIFEST_KEYS, '$', issues);

    if (manifest.schema_version !== VISUAL_MANIFEST_SCHEMA_VERSION) {
        issues.push({
            code: 'SCHEMA_VERSION_UNSUPPORTED',
            path: '$.schema_version',
            message: `schema_version deve ser ${VISUAL_MANIFEST_SCHEMA_VERSION}`,
        });
    }
    if (!['complete', 'incomplete', 'invalid'].includes(manifest.status)) {
        issues.push({ code: 'STATUS_INVALID', path: '$.status', message: '$.status é inválido' });
    }

    validateNamedFile(manifest, 'source_file', issues);
    validateNamedFile(manifest, 'output_file', issues);

    ['source_sha256', 'output_sha256', 'visual_plan_sha256'].forEach(field => {
        if (typeof manifest[field] !== 'string' || !SHA256_PATTERN.test(manifest[field])) {
            issues.push({
                code: 'HASH_INVALID',
                path: `$.${field}`,
                message: `$.${field} deve ser um SHA-256 hexadecimal`,
            });
        }
    });

    if (!Array.isArray(manifest.topics) || manifest.topics.length === 0) {
        issues.push({
            code: 'TOPICS_REQUIRED',
            path: '$.topics',
            message: '$.topics deve conter pelo menos um tópico',
        });
        return issues;
    }
    if (manifest.topics.length > MAX_MANIFEST_TOPICS) {
        issues.push({
            code: 'TOPICS_LIMIT_EXCEEDED',
            path: '$.topics',
            message: `$.topics excede o limite de ${MAX_MANIFEST_TOPICS} tópicos`,
        });
    }

    const topicSlugs = new Set();
    let violationCount = 0;
    manifest.topics.forEach((topic, topicIndex) => {
        const topicPath = `$.topics[${topicIndex}]`;
        if (!isPlainObject(topic)) {
            issues.push({ code: 'TOPIC_INVALID', path: topicPath, message: `${topicPath} deve ser objeto` });
            return;
        }
        addUnknownKeyIssues(topic, TOPIC_KEYS, topicPath, issues);

        if (typeof topic.topic_slug !== 'string' || !SLUG_PATTERN.test(topic.topic_slug)) {
            issues.push({
                code: 'TOPIC_SLUG_INVALID',
                path: `${topicPath}.topic_slug`,
                message: `${topicPath}.topic_slug deve usar apenas minúsculas, números e hífens`,
            });
        } else if (topic.topic_slug.length > 300) {
            issues.push({
                code: 'TOPIC_SLUG_TOO_LONG',
                path: `${topicPath}.topic_slug`,
                message: `${topicPath}.topic_slug excede 300 caracteres`,
            });
        } else if (topicSlugs.has(topic.topic_slug)) {
            issues.push({
                code: 'TOPIC_SLUG_DUPLICATE',
                path: `${topicPath}.topic_slug`,
                message: `${topicPath}.topic_slug está duplicado no manifesto`,
            });
        }
        topicSlugs.add(topic.topic_slug);

        ['selected_variants', 'requirements', 'observed_resources', 'violations'].forEach(field => {
            if (!Array.isArray(topic[field])) {
                issues.push({
                    code: 'ARRAY_REQUIRED',
                    path: `${topicPath}.${field}`,
                    message: `${topicPath}.${field} deve ser um array`,
                });
            }
        });
        ['selected_variants', 'requirements', 'observed_resources'].forEach(field => {
            if (Array.isArray(topic[field]) && topic[field].length > MAX_TOPIC_RESOURCES) {
                issues.push({
                    code: 'TOPIC_RESOURCE_LIMIT_EXCEEDED',
                    path: `${topicPath}.${field}`,
                    message: `${topicPath}.${field} excede ${MAX_TOPIC_RESOURCES} itens`,
                });
            }
        });
        if (Array.isArray(topic.violations) && topic.violations.length > MAX_TOPIC_VIOLATIONS) {
            issues.push({
                code: 'TOPIC_VIOLATION_LIMIT_EXCEEDED',
                path: `${topicPath}.violations`,
                message: `${topicPath}.violations excede ${MAX_TOPIC_VIOLATIONS} itens`,
            });
        }

        if (Array.isArray(topic.selected_variants)) {
            topic.selected_variants.forEach((variant, variantIndex) => {
                validateVariant(variant, `${topicPath}.selected_variants[${variantIndex}]`, issues);
            });
        }
        if (Array.isArray(topic.requirements)) {
            topic.requirements.forEach((requirement, requirementIndex) => {
                issues.push(...collectVisualRequirementIssues(
                    requirement,
                    `${topicPath}.requirements[${requirementIndex}]`
                ));
            });
        }
        if (Array.isArray(topic.violations)) {
            violationCount += topic.violations.length;
            topic.violations.forEach((violation, violationIndex) => {
                validateViolation(violation, `${topicPath}.violations[${violationIndex}]`, issues);
            });
        }
    });

    if (manifest.status === 'complete' && violationCount > 0) {
        issues.push({
            code: 'COMPLETE_WITH_VIOLATIONS',
            path: '$.status',
            message: 'Manifesto completo não pode conter violações',
        });
    }

    return issues;
}

function validateVisualManifest(manifest) {
    const issues = collectVisualManifestIssues(manifest);
    if (issues.length > 0) throw new VisualManifestValidationError(issues);
    return manifest;
}

function findTopic(plan, topicSlug) {
    const topic = plan.topics.find(candidate => candidate.topic_slug === topicSlug);
    if (!topic) {
        const error = new Error(`Tópico ${topicSlug} não existe no plano visual.`);
        error.code = 'PYGEM_VISUAL_TOPIC_NOT_FOUND';
        throw error;
    }
    return topic;
}

function createVisualManifest({
    sourceFile,
    outputFile,
    sourceContent,
    outputContent,
    visualPlan,
    topicResults,
}) {
    validateVisualPlan(visualPlan);
    if (!Array.isArray(topicResults) || topicResults.length === 0) {
        const error = new Error('Informe ao menos um resultado de tópico para o manifesto visual.');
        error.code = 'PYGEM_VISUAL_TOPIC_RESULTS_REQUIRED';
        throw error;
    }

    const topics = topicResults.map(result => {
        const plannedTopic = findTopic(visualPlan, result.topicSlug);
        const violations = Array.isArray(result.violations)
            ? result.violations.map(violation => ({ ...violation }))
            : [];
        return {
            topic_slug: plannedTopic.topic_slug,
            selected_variants: plannedTopic.requirements
                .filter(requirement => requirement.variant_family)
                .map(requirement => ({
                    resource: requirement.resource,
                    semantic_role: requirement.semantic_role,
                    variant_family: requirement.variant_family,
                })),
            requirements: plannedTopic.requirements.map(requirement => ({ ...requirement })),
            observed_resources: Array.isArray(result.observedResources)
                ? result.observedResources.map(resource => ({ ...resource }))
                : [],
            violations,
        };
    });
    const hasViolations = topics.some(topic => topic.violations.length > 0);

    const manifest = {
        schema_version: VISUAL_MANIFEST_SCHEMA_VERSION,
        status: hasViolations ? 'incomplete' : 'complete',
        source_file: path.basename(String(sourceFile || '')),
        output_file: path.basename(String(outputFile || '')),
        source_sha256: sha256Buffer(sourceContent),
        output_sha256: sha256Buffer(outputContent),
        visual_plan_sha256: sha256Buffer(JSON.stringify(visualPlan)),
        topics,
    };

    return validateVisualManifest(manifest);
}

function writeVisualManifestAtomic(filePath, manifest) {
    validateVisualManifest(manifest);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    return filePath;
}

module.exports = {
    VISUAL_MANIFEST_SCHEMA_VERSION,
    VisualManifestValidationError,
    sha256Buffer,
    collectVisualManifestIssues,
    validateVisualManifest,
    createVisualManifest,
    writeVisualManifestAtomic,
};
