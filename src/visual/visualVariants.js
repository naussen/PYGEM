const crypto = require('crypto');
const { validateVisualPlan } = require('./visualPlanValidator');

const COMPATIBLE_VARIANTS = Object.freeze({
    table: Object.freeze({
        comparison: Object.freeze(['criteria-as-rows', 'entities-as-rows', 'split-comparison']),
        classification: Object.freeze(['entities-as-rows', 'criteria-as-rows']),
        timeline: Object.freeze(['criteria-as-rows']),
        hierarchy: Object.freeze(['entities-as-rows']),
        rule: Object.freeze(['rule-consequence']),
        exception: Object.freeze(['rule-consequence']),
        critical_order: Object.freeze(['criteria-as-rows', 'rule-consequence']),
        memory_key: Object.freeze(['entities-as-rows']),
    }),
    mermaid: Object.freeze({
        timeline: Object.freeze(['phase-groups']),
        decision_flow: Object.freeze(['decision-first']),
        process_flow: Object.freeze(['linear-stages']),
        hierarchy: Object.freeze(['root-branches']),
        classification: Object.freeze(['root-branches']),
        critical_order: Object.freeze(['linear-stages']),
    }),
    highlight: Object.freeze({
        rule: Object.freeze(['summary-after', 'keyword-rule']),
        exception: Object.freeze(['warning-before', 'exception-block']),
        critical_order: Object.freeze(['warning-before', 'keyword-rule']),
        memory_key: Object.freeze(['keyword-rule']),
    }),
    mnemonic: Object.freeze({
        memory_key: Object.freeze(['source-preserved']),
    }),
});

const VARIANT_INSTRUCTIONS = Object.freeze({
    'criteria-as-rows': 'Tabela: use critérios na primeira coluna e entidades ou situações nas demais; reorganize a ordem dos critérios.',
    'entities-as-rows': 'Tabela: use entidades ou situações nas linhas e critérios nas colunas; crie cabeçalhos próprios e objetivos.',
    'split-comparison': 'Tabela: separe os lados comparados em grupos claramente distintos, com cabeçalhos próprios e ordem diferente da referência.',
    'rule-consequence': 'Tabela: organize regra ou condição, consequência e exceção em colunas distintas quando existirem.',
    'linear-stages': 'Mermaid: represente a sequência como flowchart vertical, preservando rigorosamente causalidade e ordem normativa.',
    'decision-first': 'Mermaid: inicie pela pergunta decisória e derive os caminhos condicionais sem inverter respostas ou efeitos.',
    'root-branches': 'Mermaid: use um conceito-raiz e ramos hierárquicos; não converta classificação em sequência temporal.',
    'phase-groups': 'Mermaid: agrupe fases cronológicas e preserve a ordem temporal, sem reproduzir a geometria da referência.',
    'warning-before': 'Realce: posicione um aviso curto antes da regra crítica ou exceção, com redação própria.',
    'summary-after': 'Realce: apresente uma síntese objetiva depois da explicação correspondente.',
    'keyword-rule': 'Realce: destaque a palavra-chave e formule a regra em bloco conciso, sem copiar a composição original.',
    'exception-block': 'Realce: isole a exceção em bloco próprio e explicite seu limite sem ampliar seu alcance.',
    'source-preserved': 'Mnemônico: preserve apenas o vínculo factual original, sem criar letras ou associações inexistentes.',
});

function makeVariantError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function getCompatibleVariants(resource, semanticRole) {
    return COMPATIBLE_VARIANTS[resource]?.[semanticRole] || [];
}

function getStableVariantIndex(seed, topicSlug, resource, semanticRole, variantCount) {
    if (!Number.isInteger(variantCount) || variantCount < 1) {
        throw makeVariantError(
            'PYGEM_VISUAL_VARIANT_LIST_EMPTY',
            'A seleção determinística exige ao menos uma variante compatível.'
        );
    }
    const hash = crypto
        .createHash('sha256')
        .update(`${seed}${topicSlug}${resource}${semanticRole}`, 'utf8')
        .digest('hex');
    return Number(BigInt(`0x${hash}`) % BigInt(variantCount));
}

function selectVariantFamily({ seed, topicSlug, requirement }) {
    const compatible = getCompatibleVariants(requirement.resource, requirement.semantic_role);
    if (compatible.length === 0) {
        throw makeVariantError(
            'PYGEM_VISUAL_VARIANT_ROLE_UNSUPPORTED',
            `Não há variante de ${requirement.resource} compatível com ${requirement.semantic_role}.`,
            {
                topicSlug,
                resource: requirement.resource,
                semanticRole: requirement.semantic_role,
            }
        );
    }

    if (requirement.variant_family) {
        if (!compatible.includes(requirement.variant_family)) {
            throw makeVariantError(
                'PYGEM_VISUAL_VARIANT_ROLE_MISMATCH',
                `${requirement.variant_family} não é compatível com o papel ${requirement.semantic_role}.`,
                {
                    topicSlug,
                    resource: requirement.resource,
                    semanticRole: requirement.semantic_role,
                    variantFamily: requirement.variant_family,
                }
            );
        }
        return requirement.variant_family;
    }

    const index = getStableVariantIndex(
        seed,
        topicSlug,
        requirement.resource,
        requirement.semantic_role,
        compatible.length
    );
    return compatible[index];
}

function applyVisualVariants(plan) {
    validateVisualPlan(plan);
    const selectedPlan = {
        ...plan,
        topics: plan.topics.map(topic => ({
            ...topic,
            requirements: topic.requirements.map(requirement => ({
                ...requirement,
                variant_family: selectVariantFamily({
                    seed: plan.diversification_seed,
                    topicSlug: topic.topic_slug,
                    requirement,
                }),
            })),
        })),
    };
    return validateVisualPlan(selectedPlan);
}

function getVariantInstruction(variantFamily) {
    return VARIANT_INSTRUCTIONS[variantFamily] || null;
}

module.exports = {
    COMPATIBLE_VARIANTS,
    VARIANT_INSTRUCTIONS,
    getCompatibleVariants,
    getStableVariantIndex,
    selectVariantFamily,
    applyVisualVariants,
    getVariantInstruction,
};
