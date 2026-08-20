const fs = require('fs');
const path = require('path');
const {
    MAX_VISUAL_GUIDE_BYTES,
    compileVisualGuide,
    sha256,
} = require('./visualGuideCompiler');
const { validateVisualPlan } = require('./visualPlanValidator');
const { applyVisualVariants } = require('./visualVariants');

const VISUAL_OPTION_NAMES = new Set([
    'visual-guide',
    'visual-plan',
    'visual-discipline',
    'visual-guide-id',
    'visual-seed',
]);

function makeVisualError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function collectNamedOptions(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index] || '');
        if (!argument.startsWith('--')) continue;
        const [rawName, inlineValue] = argument.slice(2).split('=', 2);
        if (!VISUAL_OPTION_NAMES.has(rawName)) continue;

        const value = inlineValue ?? argv[index + 1];
        if (value == null || (!inlineValue && String(value).startsWith('--'))) {
            throw makeVisualError(
                'PYGEM_VISUAL_OPTION_VALUE_REQUIRED',
                `A opção --${rawName} exige um valor.`
            );
        }
        if (values.has(rawName)) {
            throw makeVisualError(
                'PYGEM_VISUAL_OPTION_DUPLICATE',
                `A opção --${rawName} foi informada mais de uma vez.`
            );
        }
        values.set(rawName, String(value));
        if (inlineValue == null) index += 1;
    }
    return values;
}

function parseVisualOptions(argv = process.argv.slice(2), env = process.env) {
    const cli = collectNamedOptions(argv);
    const options = {
        visualGuidePath: cli.get('visual-guide') || env.PYGEM_VISUAL_GUIDE || null,
        visualPlanPath: cli.get('visual-plan') || env.PYGEM_VISUAL_PLAN || null,
        discipline: cli.get('visual-discipline') || env.PYGEM_VISUAL_DISCIPLINE || null,
        guideId: cli.get('visual-guide-id') || env.PYGEM_VISUAL_GUIDE_ID || null,
        diversificationSeed: cli.get('visual-seed') || env.PYGEM_VISUAL_SEED || null,
    };

    if (options.visualGuidePath && options.visualPlanPath) {
        throw makeVisualError(
            'PYGEM_VISUAL_INPUT_CONFLICT',
            'Informe somente --visual-guide ou --visual-plan, nunca ambos.'
        );
    }
    if (options.visualGuidePath && !String(options.discipline || '').trim()) {
        throw makeVisualError(
            'PYGEM_VISUAL_DISCIPLINE_REQUIRED',
            '--visual-guide exige --visual-discipline ou PYGEM_VISUAL_DISCIPLINE.'
        );
    }
    return options;
}

function stripWrappingQuotes(value) {
    const trimmed = String(value || '').trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
}

function promptForOptionalVisualGuide(options, question) {
    if (options.visualGuidePath || options.visualPlanPath) return options;
    if (typeof question !== 'function') {
        throw new TypeError('A função de leitura interativa é obrigatória.');
    }

    const visualGuidePath = stripWrappingQuotes(question(
        '🎨 Caminho do guia visual Markdown (opcional; Enter para ignorar): '
    ));
    if (!visualGuidePath) return options;

    const discipline = String(question('📚 Disciplina descrita no guia visual: ') || '').trim();
    if (!discipline) {
        throw makeVisualError(
            'PYGEM_VISUAL_DISCIPLINE_REQUIRED',
            'A disciplina é obrigatória quando um guia visual Markdown é informado.'
        );
    }

    return {
        ...options,
        visualGuidePath,
        discipline,
    };
}

function readBoundedFile(filePath, label) {
    const resolvedPath = path.resolve(String(filePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw makeVisualError(
            'PYGEM_VISUAL_INPUT_NOT_FOUND',
            `${label} não encontrado: ${resolvedPath}`
        );
    }
    const size = fs.statSync(resolvedPath).size;
    if (size > MAX_VISUAL_GUIDE_BYTES) {
        throw makeVisualError(
            'PYGEM_VISUAL_INPUT_TOO_LARGE',
            `${label} excede o limite de ${MAX_VISUAL_GUIDE_BYTES} bytes.`
        );
    }
    return {
        resolvedPath,
        content: fs.readFileSync(resolvedPath, 'utf8'),
    };
}

function loadVisualContext(options) {
    if (!options.visualGuidePath && !options.visualPlanPath) return null;

    if (options.visualPlanPath) {
        const loaded = readBoundedFile(options.visualPlanPath, 'Plano visual');
        let plan;
        try {
            plan = JSON.parse(loaded.content);
        } catch (error) {
            throw makeVisualError(
                'PYGEM_VISUAL_PLAN_JSON_INVALID',
                `Plano visual não contém JSON válido: ${error.message}`
            );
        }
        const selectedPlan = applyVisualVariants(plan);
        return {
            inputType: 'plan',
            inputPath: loaded.resolvedPath,
            plan: selectedPlan,
            planHash: sha256(JSON.stringify(selectedPlan)),
        };
    }

    const loaded = readBoundedFile(options.visualGuidePath, 'Relatório visual');
    const compiledPlan = compileVisualGuide(loaded.content, {
        discipline: options.discipline,
        guideId: options.guideId,
        diversificationSeed: options.diversificationSeed,
    });
    const plan = applyVisualVariants(compiledPlan);
    return {
        inputType: 'guide',
        inputPath: loaded.resolvedPath,
        plan,
        planHash: sha256(JSON.stringify(plan)),
    };
}

function compactForMatch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/[^a-z0-9]+/g, '');
}

function isPredominantlyUppercase(value) {
    const letters = String(value || '').match(/[\p{L}]/gu) || [];
    if (letters.length < 4) return false;
    const uppercase = letters.filter(letter => letter === letter.toLocaleUpperCase('pt-BR')).length;
    return uppercase / letters.length >= 0.8;
}

function extractTitleCandidates(content) {
    const candidates = [];
    const seen = new Set();
    const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const firstContentIndex = lines.findIndex(line => line.trim());

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > 220) return;
        const marker = trimmed.match(/^@@@?[ \t]+(?!#)(\S.*)$/);
        const heading = trimmed.match(/^#{1,6}\s+(\S.*)$/);
        const isFirst = index === firstContentIndex;
        const title = marker?.[1] || heading?.[1] || (isFirst || isPredominantlyUppercase(trimmed) ? trimmed : null);
        if (!title) return;
        const compact = compactForMatch(title);
        if (compact.length < 4 || seen.has(compact)) return;
        seen.add(compact);
        candidates.push({ title, compact, line: index + 1 });
    });
    return candidates;
}

function extractFileIndex(filePath) {
    return path.basename(String(filePath || '')).match(/^(\d{3})(?:_|-)/)?.[1] || null;
}

function titleMatchesCandidate(topicTitle, candidate) {
    const topicCompact = compactForMatch(topicTitle);
    if (topicCompact.length < 8) return false;
    if (topicCompact === candidate.compact) return true;
    const shorterLength = Math.min(topicCompact.length, candidate.compact.length);
    const longerLength = Math.max(topicCompact.length, candidate.compact.length);
    return shorterLength / longerLength >= 0.72
        && (topicCompact.includes(candidate.compact) || candidate.compact.includes(topicCompact));
}

function selectVisualTopicsForFile(filePath, content, plan) {
    validateVisualPlan(plan);
    const fileIndex = extractFileIndex(filePath);
    const candidates = extractTitleCandidates(content);
    const matches = plan.topics.filter(topic => (
        (topic.source_index && topic.source_index === fileIndex)
        || candidates.some(candidate => titleMatchesCandidate(topic.canonical_title, candidate))
    ));

    if (matches.length === 0) {
        throw makeVisualError(
            'PYGEM_VISUAL_TOPIC_NOT_MATCHED',
            `Nenhum tópico do plano visual corresponde a ${path.basename(filePath)}.`,
            {
                fileName: path.basename(filePath),
                fileIndex,
                candidateLines: candidates.map(candidate => candidate.line),
            }
        );
    }
    return matches;
}

function writeVisualPlanAtomic(outputDirectory, plan) {
    validateVisualPlan(plan);
    const outputPath = path.join(outputDirectory, '_visual-plan.json');
    const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(outputDirectory, { recursive: true });
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, outputPath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    return outputPath;
}

module.exports = {
    parseVisualOptions,
    promptForOptionalVisualGuide,
    loadVisualContext,
    compactForMatch,
    extractTitleCandidates,
    extractFileIndex,
    titleMatchesCandidate,
    selectVisualTopicsForFile,
    writeVisualPlanAtomic,
};
