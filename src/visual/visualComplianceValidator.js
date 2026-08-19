const { detectVisualResources, normalizeKey } = require('./visualResourceDetector');

function compact(value) {
    return normalizeKey(value);
}

function titleMatches(topicTitle, title) {
    const expected = compact(topicTitle);
    const actual = compact(title);
    if (!expected || !actual) return false;
    return expected === actual || expected.includes(actual) || actual.includes(expected);
}

function splitTopicSegments(markdown, topics) {
    const source = String(markdown || '');
    if (!Array.isArray(topics) || topics.length <= 1) {
        return new Map([[topics?.[0]?.topic_slug || '__all__', source]]);
    }

    const lines = source.split(/\r?\n/);
    const starts = topics.map(topic => {
        const index = lines.findIndex(line => {
            const heading = line.trim().match(/^@@@?\s+(.+)$|^#{1,6}\s+(.+)$/);
            return heading && titleMatches(topic.canonical_title, heading[1] || heading[2]);
        });
        return { topic, index };
    }).filter(item => item.index >= 0).sort((left, right) => left.index - right.index);

    if (starts.length === 0) return new Map(topics.map(topic => [topic.topic_slug, source]));
    const result = new Map();
    starts.forEach((item, index) => {
        const end = starts[index + 1]?.index ?? lines.length;
        result.set(item.topic.topic_slug, lines.slice(item.index, end).join('\n'));
    });
    topics.forEach(topic => {
        if (!result.has(topic.topic_slug)) result.set(topic.topic_slug, source);
    });
    return result;
}

function makeIssue(code, topic, requirement, message, details = {}) {
    return {
        code,
        topic_slug: topic.topic_slug,
        resource: requirement.resource,
        semantic_role: requirement.semantic_role,
        message,
        ...details,
    };
}

function validateTargetSection(observed, targetSection) {
    const target = compact(targetSection);
    return observed.some(item => {
        const section = compact(item.section);
        return section === target || target.includes(section);
    });
}

function normalizeFact(value) {
    return String(value || '')
        .replace(/[`*_>#|:[\]()`]/g, ' ')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findDuplicatedFacts(resources) {
    const facts = [];
    resources.forEach(resource => {
        const fact = normalizeFact(resource.text);
        if (fact.length < 32) return;
        facts.push({ fact, resource });
    });
    const duplicates = [];
    for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < facts.length; rightIndex += 1) {
            const left = facts[leftIndex];
            const right = facts[rightIndex];
            if (left.resource.resource === right.resource.resource) continue;
            if (!left.fact.includes(right.fact) && !right.fact.includes(left.fact)) continue;
            const fact = left.fact.length <= right.fact.length ? left.fact : right.fact;
            duplicates.push({ fact, occurrences: [left.resource, right.resource] });
        }
    }
    return duplicates;
}

function validateVisualCompliance(markdown, options = {}) {
    const visualTopics = Array.isArray(options.visualTopics) ? options.visualTopics : [];
    if (visualTopics.length === 0) {
        return { valid: true, issues: [], topics: [], detected: detectVisualResources(markdown) };
    }
    const segments = splitTopicSegments(markdown, visualTopics);
    const topicResults = [];
    const issues = [];

    visualTopics.forEach(topic => {
        const detected = detectVisualResources(segments.get(topic.topic_slug) || markdown);
        const topicIssues = [];
        topic.requirements.forEach(requirement => {
            const observed = detected.resources.filter(item => item.resource === requirement.resource);
            const count = observed.length;
            if (count < requirement.minimum) {
                topicIssues.push(makeIssue(
                    'VISUAL_RESOURCE_MISSING',
                    topic,
                    requirement,
                    `Recurso obrigatório ausente: esperado ${requirement.minimum}, encontrado ${count}.`,
                    { expected_minimum: requirement.minimum, observed_count: count }
                ));
            }
            if (count > requirement.maximum) {
                topicIssues.push(makeIssue(
                    'VISUAL_RESOURCE_EXCESS',
                    topic,
                    requirement,
                    `Quantidade máxima excedida: permitido ${requirement.maximum}, encontrado ${count}.`,
                    { expected_maximum: requirement.maximum, observed_count: count }
                ));
            }
            if (requirement.target_section && !validateTargetSection(observed, requirement.target_section)) {
                topicIssues.push(makeIssue(
                    'VISUAL_TARGET_SECTION_MISSING',
                    topic,
                    requirement,
                    `Nenhum recurso foi encontrado na seção-alvo ${requirement.target_section}.`,
                    { target_section: requirement.target_section }
                ));
            }
        });
        if (!detected.mermaid.valid) {
            topicIssues.push(...detected.mermaid.issues.map(message => makeIssue(
                'VISUAL_MERMAID_INVALID',
                topic,
                { resource: 'mermaid', semantic_role: 'process_flow' },
                message
            )));
        }
        findDuplicatedFacts(detected.resources).forEach(duplicate => {
            const first = duplicate.occurrences[0];
            topicIssues.push(makeIssue(
                'VISUAL_FACT_DUPLICATED',
                topic,
                { resource: first.resource, semantic_role: 'rule' },
                'O mesmo fato textual foi repetido em mais de um recurso visual.',
                {
                    fact: duplicate.fact,
                    resources: duplicate.occurrences.map(item => item.resource),
                }
            ));
        });
        issues.push(...topicIssues);
        topicResults.push({
            topic_slug: topic.topic_slug,
            observed_resources: detected.resources,
            violations: topicIssues,
        });
    });

    return {
        valid: issues.length === 0,
        issues,
        topics: topicResults,
    };
}

function assertVisualCompliance(markdown, options = {}) {
    const result = validateVisualCompliance(markdown, options);
    if (!result.valid) {
        const error = new Error(`Conformidade visual inválida: ${result.issues.map(issue => issue.message).join(' ')}`);
        error.code = 'PYGEM_VISUAL_COMPLIANCE_INVALID';
        error.details = result;
        throw error;
    }
    return markdown;
}

module.exports = {
    splitTopicSegments,
    validateVisualCompliance,
    assertVisualCompliance,
};
