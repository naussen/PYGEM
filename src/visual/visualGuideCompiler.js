const crypto = require('crypto');
const { validateVisualPlan } = require('./visualPlanValidator');

const ACRONYMS = new Set([
    'ADM', 'AUDIN', 'CAE', 'CFC', 'CRC', 'CVM', 'DC', 'DCS', 'NBC', 'NF', 'PAA', 'PJ', 'PL',
    'RFA', 'RT', 'TA', 'TEC', 'TI',
]);
const MAX_VISUAL_GUIDE_BYTES = 2 * 1024 * 1024;
const MAX_VISUAL_GUIDE_LINE_LENGTH = 20000;

class VisualGuideCompilationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'VisualGuideCompilationError';
        this.code = code;
        this.details = details;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stripMarkdown(value) {
    return String(value || '')
        .replace(/[`*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function canonicalizeTitle(value) {
    const cleaned = stripMarkdown(value)
        .replace(/^\d+\.\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';

    const words = cleaned.toLocaleLowerCase('pt-BR').split(' ');
    const normalized = words.map((word, index) => {
        const punctuationMatch = word.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}ºª-]+)(.*)$/u);
        if (!punctuationMatch) return word;
        const [, prefix, core, suffix] = punctuationMatch;
        const upperCore = core.toLocaleUpperCase('pt-BR');
        if (ACRONYMS.has(upperCore) || /^\d+$/.test(core)) {
            return `${prefix}${upperCore}${suffix}`;
        }
        if (index === 0) {
            return `${prefix}${core.charAt(0).toLocaleUpperCase('pt-BR')}${core.slice(1)}${suffix}`;
        }
        return `${prefix}${core}${suffix}`;
    });

    return normalized.join(' ');
}

function slugify(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function parseGuideSections(markdown) {
    const lines = String(markdown || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const sections = [];
    let current = null;

    lines.forEach((line, lineIndex) => {
        const heading = line.match(/^###(?!#)\s+(?:(\d+)\.\s*)?(.+?)\s*$/);
        if (heading) {
            if (current) sections.push(current);
            current = {
                guideSectionIndex: heading[1] ? Number(heading[1]) : null,
                rawTitle: heading[2],
                startLine: lineIndex + 1,
                bodyLines: [],
            };
            return;
        }
        if (current) current.bodyLines.push(line);
    });
    if (current) sections.push(current);

    return sections;
}

function getRecommendedExcerpt(body) {
    const lines = String(body || '').split(/\r?\n/);
    const recommendedIndex = lines.findIndex(line => /corre[cç][aã]o recomendada/i.test(line));
    if (recommendedIndex < 0) return String(body || '');
    return lines.slice(recommendedIndex).join('\n');
}

function inferSemanticRole(resource, text) {
    const normalized = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (resource === 'mnemonic') return 'memory_key';
    if (resource === 'highlight') {
        if (/ordem rigida|logo apos|posicionamento|sequencia obrigatoria/.test(normalized)) {
            return 'critical_order';
        }
        if (/excecao|cuidado|pegadinha|nao pode|proibid|vedad/.test(normalized)) return 'exception';
        return 'rule';
    }
    if (resource === 'mermaid') {
        if (/linha do tempo|momento 0?1|cronolog|datas cruciais/.test(normalized)) return 'timeline';
        if (/tomada de decisao|ramific|pergunta|sim ou nao|sim.*nao/.test(normalized)) return 'decision_flow';
        if (/hierarqu|mapa mental|ramos|classifica/.test(normalized)) return 'hierarchy';
        return 'process_flow';
    }
    if (resource === 'table') {
        if (/linha do tempo|momento 0?1|cronolog|datas cruciais/.test(normalized)) return 'timeline';
        if (/compar|versus|\bvs\b|paralel|diferenc|duas colunas|tres colunas/.test(normalized)) {
            return 'comparison';
        }
        if (/classifica|categoria|tipos|modalidades|mnemonico/.test(normalized)) return 'classification';
    }
    return 'rule';
}

function detectRequirements(sectionText) {
    const recommended = getRecommendedExcerpt(sectionText);
    const scanText = recommended.trim() || String(sectionText || '');
    const normalized = scanText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const detected = [];

    const definitions = [
        {
            resource: 'table',
            pattern: /\b(tabelas?|matri(?:z|zes)|quadros?(?:-resumo)?|colunas?(?:\s+(?:de\s+)?compara[cç][aã]o|\s+comparativas?)?)\b/,
            maximum: 2,
        },
        {
            resource: 'mermaid',
            pattern: /\b(mermaid|fluxogramas?|diagramas?|mapas? mentais?|graficos?)\b/,
            maximum: 1,
        },
        {
            resource: 'highlight',
            pattern: /\b(blockquotes?|admonitions?|caixas?|boxes|callouts?|avisos?|alertas?|atencao|cuidado|destaques?|negrito|enfase|danger|warning|note|important)\b/,
            maximum: 3,
        },
        {
            resource: 'mnemonic',
            pattern: /\b(mnemonico|mnemônico)\b/,
            maximum: 1,
        },
    ];

    definitions.forEach(definition => {
        if (!definition.pattern.test(normalized)) return;
        detected.push({
            resource: definition.resource,
            semantic_role: inferSemanticRole(definition.resource, scanText),
            required: true,
            minimum: 1,
            maximum: definition.maximum,
        });
    });

    return detected;
}

function extractExplicitSourceIndex(title, body) {
    const text = `${title}\n${body}`;
    const tagged = text.match(/\[\s*arquivo\s*:\s*(\d{3})\s*\]/i);
    if (tagged) return tagged[1];
    const namedFile = text.match(/(?:^|[^0-9])(\d{3})_[^\s`]*\.(?:md|json)\b/i);
    return namedFile ? namedFile[1] : null;
}

function isIndexSection(title) {
    const normalized = slugify(title);
    return normalized === 'sumario'
        || normalized === 'indice'
        || normalized.startsWith('sumario-')
        || normalized.startsWith('indice-');
}

function compileVisualGuide(markdown, options = {}) {
    if (typeof markdown !== 'string' || !markdown.trim()) {
        throw new VisualGuideCompilationError(
            'PYGEM_VISUAL_GUIDE_EMPTY',
            'O relatório visual está vazio.'
        );
    }
    if (Buffer.byteLength(markdown, 'utf8') > MAX_VISUAL_GUIDE_BYTES) {
        throw new VisualGuideCompilationError(
            'PYGEM_VISUAL_GUIDE_TOO_LARGE',
            `O relatório visual excede o limite de ${MAX_VISUAL_GUIDE_BYTES} bytes.`
        );
    }
    const pathologicalLineIndex = markdown
        .split(/\r?\n/)
        .findIndex(line => line.length > MAX_VISUAL_GUIDE_LINE_LENGTH);
    if (pathologicalLineIndex >= 0) {
        throw new VisualGuideCompilationError(
            'PYGEM_VISUAL_GUIDE_LINE_TOO_LONG',
            `A linha ${pathologicalLineIndex + 1} excede ${MAX_VISUAL_GUIDE_LINE_LENGTH} caracteres.`,
            { line: pathologicalLineIndex + 1 }
        );
    }

    const discipline = String(options.discipline || '').trim();
    if (!discipline) {
        throw new VisualGuideCompilationError(
            'PYGEM_VISUAL_DISCIPLINE_REQUIRED',
            'Informe a disciplina ao compilar o relatório visual.'
        );
    }

    const sections = parseGuideSections(markdown)
        .filter(section => !isIndexSection(section.rawTitle));
    if (sections.length === 0) {
        throw new VisualGuideCompilationError(
            'PYGEM_VISUAL_GUIDE_WITHOUT_TOPICS',
            'Nenhum tópico H3 foi encontrado no relatório visual.'
        );
    }

    const guideId = slugify(options.guideId || `${discipline}-visual-v1`);
    const diversificationSeed = String(options.diversificationSeed || guideId).trim();
    const topics = sections.map(section => {
        const canonicalTitle = canonicalizeTitle(section.rawTitle);
        const body = section.bodyLines.join('\n').trim();
        if (!canonicalTitle) {
            throw new VisualGuideCompilationError(
                'PYGEM_VISUAL_TOPIC_WITHOUT_TITLE',
                `Tópico iniciado na linha ${section.startLine} não possui título utilizável.`,
                { line: section.startLine }
            );
        }

        const topic = {
            canonical_title: canonicalTitle,
            topic_slug: slugify(canonicalTitle),
            requirements: detectRequirements(body),
        };
        if (section.guideSectionIndex) topic.guide_section_index = section.guideSectionIndex;
        const sourceIndex = extractExplicitSourceIndex(section.rawTitle, body);
        if (sourceIndex) topic.source_index = sourceIndex;
        return topic;
    });

    const plan = {
        schema_version: 1,
        discipline,
        guide_id: guideId,
        guide_sha256: sha256(markdown),
        diversification_seed: diversificationSeed,
        topics,
    };

    return validateVisualPlan(plan, { expectedGuideHash: sha256(markdown) });
}

module.exports = {
    MAX_VISUAL_GUIDE_BYTES,
    MAX_VISUAL_GUIDE_LINE_LENGTH,
    VisualGuideCompilationError,
    sha256,
    slugify,
    canonicalizeTitle,
    parseGuideSections,
    getRecommendedExcerpt,
    inferSemanticRole,
    detectRequirements,
    compileVisualGuide,
};
