const VISUAL_PLAN_SCHEMA_VERSION = 1;
const MAX_VISUAL_TOPICS = 500;
const MAX_REQUIREMENTS_PER_TOPIC = 16;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESOURCES = new Set(['table', 'mermaid', 'highlight', 'mnemonic']);
const SEMANTIC_ROLES = new Set([
    'comparison',
    'classification',
    'timeline',
    'decision_flow',
    'process_flow',
    'hierarchy',
    'rule',
    'exception',
    'critical_order',
    'memory_key',
]);
const VARIANT_FAMILIES = new Set([
    'criteria-as-rows',
    'entities-as-rows',
    'split-comparison',
    'rule-consequence',
    'linear-stages',
    'decision-first',
    'root-branches',
    'phase-groups',
    'warning-before',
    'summary-after',
    'keyword-rule',
    'exception-block',
    'source-preserved',
]);
const VARIANTS_BY_RESOURCE = new Map([
    ['table', new Set(['criteria-as-rows', 'entities-as-rows', 'split-comparison', 'rule-consequence'])],
    ['mermaid', new Set(['linear-stages', 'decision-first', 'root-branches', 'phase-groups'])],
    ['highlight', new Set(['warning-before', 'summary-after', 'keyword-rule', 'exception-block'])],
    ['mnemonic', new Set(['source-preserved'])],
]);

const ROOT_KEYS = new Set([
    'schema_version',
    'discipline',
    'guide_id',
    'guide_sha256',
    'diversification_seed',
    'topics',
]);
const TOPIC_KEYS = new Set([
    'source_index',
    'guide_section_index',
    'canonical_title',
    'topic_slug',
    'requirements',
]);
const REQUIREMENT_KEYS = new Set([
    'resource',
    'semantic_role',
    'required',
    'minimum',
    'maximum',
    'target_section',
    'variant_family',
]);

class VisualPlanValidationError extends Error {
    constructor(issues) {
        super(`Plano visual inválido: ${issues.map(issue => issue.message).join('; ')}`);
        this.name = 'VisualPlanValidationError';
        this.code = 'PYGEM_VISUAL_PLAN_INVALID';
        this.issues = issues;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addUnknownKeyIssues(value, allowedKeys, path, issues) {
    Object.keys(value).forEach(key => {
        if (!allowedKeys.has(key)) {
            issues.push({
                code: 'UNKNOWN_FIELD',
                path: `${path}.${key}`,
                message: `${path}.${key} não é permitido pelo schema visual v1`,
            });
        }
    });
}

function addRequiredStringIssue(value, path, issues) {
    if (typeof value !== 'string' || !value.trim()) {
        issues.push({
            code: 'REQUIRED_STRING',
            path,
            message: `${path} deve ser uma string não vazia`,
        });
    }
}

function addMaximumLengthIssue(value, maximum, path, issues) {
    if (typeof value === 'string' && value.length > maximum) {
        issues.push({
            code: 'STRING_TOO_LONG',
            path,
            message: `${path} excede o limite de ${maximum} caracteres`,
        });
    }
}

function addSingleLineTextIssue(value, path, issues) {
    if (typeof value === 'string' && /[\u0000-\u001F\u007F]/.test(value)) {
        issues.push({
            code: 'CONTROL_CHARACTER_FORBIDDEN',
            path,
            message: `${path} não pode conter quebras de linha ou caracteres de controle`,
        });
    }
}

function validateRequirement(requirement, path, issues) {
    if (!isPlainObject(requirement)) {
        issues.push({
            code: 'REQUIREMENT_INVALID',
            path,
            message: `${path} deve ser um objeto`,
        });
        return;
    }

    addUnknownKeyIssues(requirement, REQUIREMENT_KEYS, path, issues);

    if (!RESOURCES.has(requirement.resource)) {
        issues.push({
            code: 'RESOURCE_INVALID',
            path: `${path}.resource`,
            message: `${path}.resource possui valor desconhecido`,
        });
    }
    if (!SEMANTIC_ROLES.has(requirement.semantic_role)) {
        issues.push({
            code: 'SEMANTIC_ROLE_INVALID',
            path: `${path}.semantic_role`,
            message: `${path}.semantic_role possui valor desconhecido`,
        });
    }
    if (typeof requirement.required !== 'boolean') {
        issues.push({
            code: 'REQUIRED_FLAG_INVALID',
            path: `${path}.required`,
            message: `${path}.required deve ser booleano`,
        });
    }
    if (!Number.isInteger(requirement.minimum) || requirement.minimum < 0) {
        issues.push({
            code: 'MINIMUM_INVALID',
            path: `${path}.minimum`,
            message: `${path}.minimum deve ser inteiro maior ou igual a zero`,
        });
    }
    if (!Number.isInteger(requirement.maximum) || requirement.maximum < 1) {
        issues.push({
            code: 'MAXIMUM_INVALID',
            path: `${path}.maximum`,
            message: `${path}.maximum deve ser inteiro maior ou igual a um`,
        });
    }
    if (
        Number.isInteger(requirement.minimum)
        && Number.isInteger(requirement.maximum)
        && requirement.minimum > requirement.maximum
    ) {
        issues.push({
            code: 'RANGE_INVALID',
            path,
            message: `${path}.minimum não pode ser superior a maximum`,
        });
    }
    if (requirement.required === true && requirement.minimum === 0) {
        issues.push({
            code: 'REQUIRED_WITH_ZERO_MINIMUM',
            path,
            message: `${path} é obrigatório, mas minimum é zero`,
        });
    }
    if (
        Object.hasOwn(requirement, 'target_section')
        && (typeof requirement.target_section !== 'string' || !requirement.target_section.trim())
    ) {
        issues.push({
            code: 'TARGET_SECTION_INVALID',
            path: `${path}.target_section`,
            message: `${path}.target_section deve ser uma string não vazia`,
        });
    }
    addMaximumLengthIssue(requirement.target_section, 300, `${path}.target_section`, issues);
    addSingleLineTextIssue(requirement.target_section, `${path}.target_section`, issues);
    if (
        Object.hasOwn(requirement, 'variant_family')
        && !VARIANT_FAMILIES.has(requirement.variant_family)
    ) {
        issues.push({
            code: 'VARIANT_FAMILY_INVALID',
            path: `${path}.variant_family`,
            message: `${path}.variant_family possui valor desconhecido`,
        });
    } else if (
        Object.hasOwn(requirement, 'variant_family')
        && RESOURCES.has(requirement.resource)
        && !VARIANTS_BY_RESOURCE.get(requirement.resource)?.has(requirement.variant_family)
    ) {
        issues.push({
            code: 'VARIANT_RESOURCE_MISMATCH',
            path: `${path}.variant_family`,
            message: `${path}.variant_family não é compatível com ${requirement.resource}`,
        });
    }
}

function collectVisualRequirementIssues(requirement, path = '$') {
    const issues = [];
    validateRequirement(requirement, path, issues);
    return issues;
}

function collectVisualPlanIssues(plan, options = {}) {
    const issues = [];

    if (!isPlainObject(plan)) {
        return [{
            code: 'PLAN_INVALID',
            path: '$',
            message: 'O plano visual deve ser um objeto JSON',
        }];
    }

    addUnknownKeyIssues(plan, ROOT_KEYS, '$', issues);

    if (plan.schema_version !== VISUAL_PLAN_SCHEMA_VERSION) {
        issues.push({
            code: 'SCHEMA_VERSION_UNSUPPORTED',
            path: '$.schema_version',
            message: `schema_version deve ser ${VISUAL_PLAN_SCHEMA_VERSION}`,
        });
    }
    addRequiredStringIssue(plan.discipline, '$.discipline', issues);
    addRequiredStringIssue(plan.guide_id, '$.guide_id', issues);
    addRequiredStringIssue(plan.diversification_seed, '$.diversification_seed', issues);
    addMaximumLengthIssue(plan.discipline, 120, '$.discipline', issues);
    addMaximumLengthIssue(plan.guide_id, 120, '$.guide_id', issues);
    addMaximumLengthIssue(plan.diversification_seed, 200, '$.diversification_seed', issues);
    addSingleLineTextIssue(plan.discipline, '$.discipline', issues);
    addSingleLineTextIssue(plan.diversification_seed, '$.diversification_seed', issues);

    if (typeof plan.guide_id === 'string' && !SLUG_PATTERN.test(plan.guide_id)) {
        issues.push({
            code: 'GUIDE_ID_INVALID',
            path: '$.guide_id',
            message: '$.guide_id deve usar apenas minúsculas, números e hífens',
        });
    }
    if (typeof plan.guide_sha256 !== 'string' || !SHA256_PATTERN.test(plan.guide_sha256)) {
        issues.push({
            code: 'GUIDE_HASH_INVALID',
            path: '$.guide_sha256',
            message: '$.guide_sha256 deve ser um SHA-256 hexadecimal',
        });
    }
    if (
        options.expectedGuideHash
        && plan.guide_sha256 !== String(options.expectedGuideHash).toLowerCase()
    ) {
        issues.push({
            code: 'GUIDE_HASH_MISMATCH',
            path: '$.guide_sha256',
            message: '$.guide_sha256 não corresponde ao relatório visual informado',
        });
    }

    if (!Array.isArray(plan.topics) || plan.topics.length === 0) {
        issues.push({
            code: 'TOPICS_REQUIRED',
            path: '$.topics',
            message: '$.topics deve conter pelo menos um tópico',
        });
        return issues;
    }
    if (plan.topics.length > MAX_VISUAL_TOPICS) {
        issues.push({
            code: 'TOPICS_LIMIT_EXCEEDED',
            path: '$.topics',
            message: `$.topics excede o limite de ${MAX_VISUAL_TOPICS} tópicos`,
        });
    }

    const slugs = new Set();
    plan.topics.forEach((topic, topicIndex) => {
        const path = `$.topics[${topicIndex}]`;
        if (!isPlainObject(topic)) {
            issues.push({
                code: 'TOPIC_INVALID',
                path,
                message: `${path} deve ser um objeto`,
            });
            return;
        }

        addUnknownKeyIssues(topic, TOPIC_KEYS, path, issues);
        addRequiredStringIssue(topic.canonical_title, `${path}.canonical_title`, issues);
        addRequiredStringIssue(topic.topic_slug, `${path}.topic_slug`, issues);
        addMaximumLengthIssue(topic.canonical_title, 300, `${path}.canonical_title`, issues);
        addMaximumLengthIssue(topic.topic_slug, 300, `${path}.topic_slug`, issues);
        addSingleLineTextIssue(topic.canonical_title, `${path}.canonical_title`, issues);

        if (typeof topic.topic_slug === 'string') {
            if (!SLUG_PATTERN.test(topic.topic_slug)) {
                issues.push({
                    code: 'TOPIC_SLUG_INVALID',
                    path: `${path}.topic_slug`,
                    message: `${path}.topic_slug deve usar apenas minúsculas, números e hífens`,
                });
            } else if (slugs.has(topic.topic_slug)) {
                issues.push({
                    code: 'TOPIC_SLUG_DUPLICATE',
                    path: `${path}.topic_slug`,
                    message: `${path}.topic_slug está duplicado no plano`,
                });
            }
            slugs.add(topic.topic_slug);
        }

        if (
            Object.hasOwn(topic, 'source_index')
            && (typeof topic.source_index !== 'string' || !/^\d{3}$/.test(topic.source_index))
        ) {
            issues.push({
                code: 'SOURCE_INDEX_INVALID',
                path: `${path}.source_index`,
                message: `${path}.source_index deve conter exatamente três dígitos`,
            });
        }
        if (
            Object.hasOwn(topic, 'guide_section_index')
            && (!Number.isInteger(topic.guide_section_index) || topic.guide_section_index < 1)
        ) {
            issues.push({
                code: 'GUIDE_SECTION_INDEX_INVALID',
                path: `${path}.guide_section_index`,
                message: `${path}.guide_section_index deve ser inteiro positivo`,
            });
        }
        if (!Array.isArray(topic.requirements)) {
            issues.push({
                code: 'REQUIREMENTS_INVALID',
                path: `${path}.requirements`,
                message: `${path}.requirements deve ser um array`,
            });
            return;
        }
        if (topic.requirements.length > MAX_REQUIREMENTS_PER_TOPIC) {
            issues.push({
                code: 'REQUIREMENTS_LIMIT_EXCEEDED',
                path: `${path}.requirements`,
                message: `${path}.requirements excede o limite de ${MAX_REQUIREMENTS_PER_TOPIC} itens`,
            });
        }

        const requirementKeys = new Set();
        topic.requirements.forEach((requirement, requirementIndex) => {
            const requirementPath = `${path}.requirements[${requirementIndex}]`;
            validateRequirement(requirement, requirementPath, issues);
            if (isPlainObject(requirement)) {
                const uniqueKey = `${requirement.resource}:${requirement.semantic_role}`;
                if (requirementKeys.has(uniqueKey)) {
                    issues.push({
                        code: 'REQUIREMENT_DUPLICATE',
                        path: requirementPath,
                        message: `${requirementPath} duplica recurso e papel semântico no tópico`,
                    });
                }
                requirementKeys.add(uniqueKey);
            }
        });
    });

    return issues;
}

function validateVisualPlan(plan, options = {}) {
    const issues = collectVisualPlanIssues(plan, options);
    if (issues.length > 0) throw new VisualPlanValidationError(issues);
    return plan;
}

module.exports = {
    VISUAL_PLAN_SCHEMA_VERSION,
    MAX_VISUAL_TOPICS,
    MAX_REQUIREMENTS_PER_TOPIC,
    RESOURCES,
    SEMANTIC_ROLES,
    VARIANT_FAMILIES,
    VARIANTS_BY_RESOURCE,
    VisualPlanValidationError,
    collectVisualRequirementIssues,
    collectVisualPlanIssues,
    validateVisualPlan,
};
