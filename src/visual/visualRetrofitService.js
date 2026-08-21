const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const geminiService = require('../services/geminiService');
const {
    readAllMdFilesInSubdirectories,
    writeRewrittenFileAtomic,
    writeUnchangedFileAtomic,
} = require('../services/fileServiceMd');
const { detectVisualResources, normalizeKey } = require('./visualResourceDetector');
const {
    loadVisualContext,
    getVisualContextForFile,
    extractTitleCandidates,
    isVisualContextInputFile,
    validateVisualDirectoryPairing,
    writeVisualContextPlansAtomic,
} = require('./visualContextService');

const START_SENTINEL = '<<<PYGEM_VISUAL_BLOCK>>>';
const END_SENTINEL = '<<<END_PYGEM_VISUAL_BLOCK>>>';
const MAX_SOURCE_CHARS = 60000;
const MAX_FRAGMENT_CHARS = 12000;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDirectory(directoryPath, label) {
    const resolved = path.resolve(String(directoryPath || ''));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`${label} inválido: ${resolved}`);
    }
    return resolved;
}

function assertSafeOutputDirectory(outputDirectory, inputDirectory, dryRun) {
    const resolved = path.resolve(String(outputDirectory || ''));
    if (!String(outputDirectory || '').trim()) throw new Error('A pasta de saída é obrigatória.');
    if (resolved === path.resolve(inputDirectory)) {
        throw new Error('A pasta de saída do retrofit deve ser diferente da pasta de entrada.');
    }
    if (!dryRun && fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
        throw new Error(`A pasta de saída deve estar vazia ou não existir: ${resolved}`);
    }
    return resolved;
}

function isPathInsideDirectory(filePath, directoryPath) {
    const relativePath = path.relative(path.resolve(directoryPath), path.resolve(filePath));
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath)
    );
}

function collectMissingRequirements(markdown, visualTopics) {
    const detected = detectVisualResources(markdown);
    const available = { ...detected.counts };
    const missing = [];
    visualTopics.forEach(topic => {
        topic.requirements.forEach(requirement => {
            const observed = available[requirement.resource] || 0;
            const deficit = Math.max(0, requirement.minimum - observed);
            for (let index = 0; index < deficit; index += 1) {
                missing.push({ topic, requirement });
            }
            available[requirement.resource] = observed + deficit;
        });
    });
    return { missing, detected };
}

function getMeaningfulTokens(value) {
    const ignored = new Set([
        'a', 'as', 'o', 'os', 'de', 'da', 'das', 'do', 'dos', 'e', 'em', 'para',
        'cpc', 'nbc', 'lei', 'modulo',
    ]);
    return (String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .match(/[a-z0-9]+/g) || [])
        .filter(token => !ignored.has(token) && !/^\d+$/.test(token));
}

function titlesAreCompatible(topicTitle, candidateTitle) {
    const topicTokens = new Set(getMeaningfulTokens(topicTitle));
    const candidateTokens = new Set(getMeaningfulTokens(candidateTitle));
    const overlap = [...topicTokens].filter(token => candidateTokens.has(token));
    return overlap.length >= 2 || overlap.some(token => token.length >= 9);
}

function findVisualTitleMismatches(files, inputDirectory, visualContext) {
    return files.flatMap(filePath => {
        const sourceIndex = path.basename(filePath).match(/^(\d{3})(?:_|-)/)?.[1];
        const visualEntry = sourceIndex ? visualContext.plansBySourceIndex.get(sourceIndex) : null;
        if (!visualEntry) return [];
        const candidates = extractTitleCandidates(fs.readFileSync(filePath, 'utf8'));
        const compatible = visualEntry.plan.topics.some(topic => (
            candidates.some(candidate => titlesAreCompatible(topic.canonical_title, candidate.title))
        ));
        return compatible ? [] : [{
            file: path.relative(inputDirectory, filePath),
            visual_index: sourceIndex,
            visual_topics: visualEntry.plan.topics.map(topic => topic.canonical_title),
            source_title: candidates[0]?.title || null,
        }];
    });
}

function buildVisualFragmentPrompt({ sourceMarkdown, visualGuide, topic, requirement }) {
    const sourceExcerpt = sourceMarkdown.slice(0, MAX_SOURCE_CHARS);
    return [
        'Você gera SOMENTE um bloco visual Markdown para complementar um material já revisado.',
        'Não reescreva, resuma, corrija ou repita o documento. Não crie títulos Markdown.',
        'Use exclusivamente fatos literais presentes na FONTE. Não invente exemplos, números, prazos ou regras.',
        'Não use HTML, links, imagens, código executável ou instruções Mermaid interativas.',
        'Para Mermaid, use securityLevel estrito: sem click, classDef, style, linkStyle, init, frontmatter ou HTML.',
        'Use identificadores Mermaid somente alfabéticos.',
        `Recurso exigido: ${requirement.resource}.`,
        `Papel semântico: ${requirement.semantic_role}.`,
        `Variante estrutural: ${requirement.variant_family || 'padrão compatível'}.`,
        `Tópico: ${topic.canonical_title}.`,
        requirement.target_section ? `Seção-alvo: ${requirement.target_section}.` : '',
        'Responda exatamente entre os delimitadores abaixo, sem texto externo:',
        START_SENTINEL,
        '[um único bloco Markdown do recurso exigido]',
        END_SENTINEL,
        'MAPA VISUAL DE REFERÊNCIA:',
        visualGuide,
        'FONTE FACTUAL:',
        sourceExcerpt,
    ].filter(Boolean).join('\n\n');
}

function extractVisualFragment(responseText) {
    const pattern = new RegExp(`${START_SENTINEL}\\s*([\\s\\S]*?)\\s*${END_SENTINEL}`);
    const match = String(responseText || '').match(pattern);
    if (!match) throw new Error('Resposta visual sem os delimitadores obrigatórios.');
    const fragment = match[1].trim();
    if (!fragment) throw new Error('Fragmento visual vazio.');
    if (fragment.length > MAX_FRAGMENT_CHARS) {
        throw new Error(`Fragmento visual excede ${MAX_FRAGMENT_CHARS} caracteres.`);
    }
    return fragment;
}

function extractNumbers(value) {
    return String(value || '').match(/\b\d+(?:[.,]\d+)*%?\b/g) || [];
}

function validateVisualFragment(fragment, requirement, sourceMarkdown) {
    if (/^\s*(?:#{1,6}|@@@?)\s+/m.test(fragment)) {
        throw new Error('Fragmento visual tentou criar ou alterar títulos.');
    }
    const withoutAllowedBreak = fragment.replace(/<br\s*\/?\s*>/gi, '');
    if (/<[^>]+>|\bon\w+\s*=|javascript:|vbscript:|data:/i.test(withoutAllowedBreak)) {
        throw new Error('Fragmento visual contém HTML, atributo ou protocolo proibido.');
    }
    const detected = detectVisualResources(fragment);
    const expectedCount = detected.counts[requirement.resource] || 0;
    if (expectedCount !== 1 || detected.resources.length !== 1) {
        throw new Error(
            `Fragmento deve conter somente 1 ${requirement.resource}; `
            + `detectados ${expectedCount} esperado(s) e ${detected.resources.length} recurso(s) no total.`
        );
    }
    if (!detected.mermaid.valid) {
        throw new Error(`Mermaid inválido: ${detected.mermaid.issues.join(' ')}`);
    }
    const sourceNumbers = new Set(extractNumbers(sourceMarkdown));
    const inventedNumbers = extractNumbers(fragment).filter(number => !sourceNumbers.has(number));
    if (inventedNumbers.length > 0) {
        throw new Error(`Fragmento introduziu numeral ausente na fonte: ${[...new Set(inventedNumbers)].join(', ')}.`);
    }
    return fragment;
}

function findInsertionOffset(sourceMarkdown, topic, requirement) {
    const lines = sourceMarkdown.split(/\r?\n/);
    const offsets = [];
    let cursor = 0;
    lines.forEach((line, index) => {
        offsets[index] = cursor;
        cursor += line.length + (sourceMarkdown.slice(cursor + line.length, cursor + line.length + 2) === '\r\n' ? 2 : 1);
    });
    const targetKeys = [requirement.target_section, topic.canonical_title]
        .filter(Boolean)
        .map(normalizeKey);
    const headings = lines.flatMap((line, index) => {
        const match = line.trim().match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        return match ? [{ index, level: match[1].length, key: normalizeKey(match[2]) }] : [];
    });
    const target = headings.find(heading => targetKeys.some(key => (
        key === heading.key || key.includes(heading.key) || heading.key.includes(key)
    )));
    if (target) {
        const next = headings.find(heading => heading.index > target.index && heading.level <= target.level);
        return next ? offsets[next.index] : sourceMarkdown.length;
    }
    const flashcards = headings.find(heading => /flashcards?/i.test(lines[heading.index]));
    return flashcards ? offsets[flashcards.index] : sourceMarkdown.length;
}

function applyInsertions(sourceMarkdown, insertions) {
    const grouped = new Map();
    insertions.forEach(insertion => {
        const existing = grouped.get(insertion.offset) || [];
        existing.push(insertion.fragment.trim());
        grouped.set(insertion.offset, existing);
    });
    let output = sourceMarkdown;
    [...grouped.entries()]
        .sort((left, right) => right[0] - left[0])
        .forEach(([offset, fragments]) => {
            const addition = `\n\n${fragments.join('\n\n')}\n\n`;
            output = `${output.slice(0, offset)}${addition}${output.slice(offset)}`;
        });
    return output;
}

function isSubsequence(source, output) {
    let sourceIndex = 0;
    for (let outputIndex = 0; outputIndex < output.length && sourceIndex < source.length; outputIndex += 1) {
        if (output[outputIndex] === source[sourceIndex]) sourceIndex += 1;
    }
    return sourceIndex === source.length;
}

function writeJsonAtomic(filePath, value) {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

async function runVisualRetrofit(options) {
    const inputDirectory = assertDirectory(options.inputDirectory, 'Pasta de entrada');
    const visualDirectory = assertDirectory(options.visualDirectory, 'Pasta visual');
    const outputDirectory = assertSafeOutputDirectory(
        options.outputDirectory,
        inputDirectory,
        Boolean(options.dryRun)
    );
    const discipline = String(options.discipline || '').trim();
    if (!discipline) throw new Error('A disciplina é obrigatória.');

    const visualContext = loadVisualContext({
        visualGuidePath: null,
        visualGuideDirectory: visualDirectory,
        visualPlanPath: null,
        discipline,
        guideId: options.guideId || null,
        diversificationSeed: options.diversificationSeed || null,
    });
    const files = readAllMdFilesInSubdirectories(inputDirectory)
        .flatMap(item => item.files)
        .filter(filePath => !isPathInsideDirectory(filePath, visualDirectory))
        .filter(filePath => !isPathInsideDirectory(filePath, outputDirectory))
        .filter(filePath => !isVisualContextInputFile(filePath, visualContext));
    const pairing = validateVisualDirectoryPairing(files, visualContext);
    const titleMismatches = findVisualTitleMismatches(files, inputDirectory, visualContext);
    const report = {
        schema_version: 1,
        mode: 'visual-retrofit',
        dry_run: Boolean(options.dryRun),
        generated_at: new Date().toISOString(),
        files: [],
        pairing: {
            missing_visual_indexes: pairing.missingVisualIndexes,
            unindexed_source_files: pairing.unindexedSourceFiles.map(filePath => path.relative(inputDirectory, filePath)),
            unused_visual_indexes: pairing.unusedVisualIndexes,
            title_mismatches: titleMismatches,
        },
    };

    if (!options.dryRun && titleMismatches.length > 0) {
        throw new Error(
            `${titleMismatches.length} associação(ões) visual(is) têm título incompatível. `
            + 'Execute --dry-run, corrija os prefixos/mapas e tente novamente.'
        );
    }

    if (!options.dryRun) {
        fs.mkdirSync(outputDirectory, { recursive: true });
        writeVisualContextPlansAtomic(outputDirectory, visualContext);
    }

    const generator = options.generator || ((prompt, metadata) => (
        geminiService.generateVisualFragment(prompt, metadata)
    ));
    for (const filePath of files) {
        const relativePath = path.relative(inputDirectory, filePath);
        const sourceMarkdown = fs.readFileSync(filePath, 'utf8');
        const sourceHash = sha256(Buffer.from(sourceMarkdown, 'utf8'));
        const fileContext = getVisualContextForFile(filePath, sourceMarkdown, visualContext);
        if (fileContext.passthrough) {
            if (!options.dryRun) {
                writeUnchangedFileAtomic(
                    outputDirectory,
                    inputDirectory,
                    filePath,
                    'sem mapa visual correspondente'
                );
            }
            report.files.push({ file: relativePath, status: 'copied', source_sha256: sourceHash, insertions: [] });
            continue;
        }

        const { missing, detected } = collectMissingRequirements(sourceMarkdown, fileContext.visualTopics);
        if (missing.length === 0) {
            if (!options.dryRun) {
                writeUnchangedFileAtomic(
                    outputDirectory,
                    inputDirectory,
                    filePath,
                    'já compatível com o mapa visual'
                );
            }
            report.files.push({
                file: relativePath,
                status: 'already-compliant',
                source_sha256: sourceHash,
                detected_resources: detected.counts,
                insertions: [],
            });
            continue;
        }
        if (options.dryRun) {
            report.files.push({
                file: relativePath,
                status: 'planned',
                source_sha256: sourceHash,
                detected_resources: detected.counts,
                missing_resources: missing.map(item => item.requirement.resource),
                insertions: [],
            });
            continue;
        }

        const sourceIndex = path.basename(filePath).match(/^(\d{3})(?:_|-)/)?.[1];
        const visualEntry = visualContext.plansBySourceIndex.get(sourceIndex);
        const visualGuide = fs.readFileSync(visualEntry.inputPath, 'utf8');
        const insertions = [];
        let failure = null;
        for (const item of missing) {
            try {
                const prompt = buildVisualFragmentPrompt({
                    sourceMarkdown,
                    visualGuide,
                    topic: item.topic,
                    requirement: item.requirement,
                });
                const response = await generator(prompt, {
                    maxOutputTokens: 2048,
                    filePath,
                    topic: item.topic,
                    requirement: item.requirement,
                });
                const fragment = validateVisualFragment(
                    extractVisualFragment(response),
                    item.requirement,
                    sourceMarkdown
                );
                insertions.push({
                    offset: findInsertionOffset(sourceMarkdown, item.topic, item.requirement),
                    fragment,
                    topic_slug: item.topic.topic_slug,
                    resource: item.requirement.resource,
                });
            } catch (error) {
                failure = error;
                break;
            }
        }

        if (failure) {
            writeUnchangedFileAtomic(
                outputDirectory,
                inputDirectory,
                filePath,
                `falha no ajuste visual: ${failure.message}`
            );
            report.files.push({
                file: relativePath,
                status: 'failed-copied',
                source_sha256: sourceHash,
                error: failure.message,
                insertions: [],
            });
            continue;
        }

        const outputMarkdown = applyInsertions(sourceMarkdown, insertions);
        if (!isSubsequence(sourceMarkdown, outputMarkdown)) {
            throw new Error(`Invariante de preservação violada em ${relativePath}.`);
        }
        const outputFilePath = writeRewrittenFileAtomic(
            outputDirectory,
            inputDirectory,
            filePath,
            outputMarkdown
        );
        report.files.push({
            file: relativePath,
            status: 'enriched',
            source_sha256: sourceHash,
            output_sha256: sha256(Buffer.from(outputMarkdown, 'utf8')),
            output_file: path.relative(outputDirectory, outputFilePath),
            insertions: insertions.map(({ topic_slug, resource }) => ({ topic_slug, resource })),
        });
    }

    report.summary = report.files.reduce((summary, item) => {
        summary[item.status] = (summary[item.status] || 0) + 1;
        return summary;
    }, {});
    if (!options.dryRun) {
        writeJsonAtomic(path.join(outputDirectory, '_visual-retrofit-report.json'), report);
    }
    return report;
}

module.exports = {
    START_SENTINEL,
    END_SENTINEL,
    collectMissingRequirements,
    titlesAreCompatible,
    findVisualTitleMismatches,
    buildVisualFragmentPrompt,
    extractVisualFragment,
    validateVisualFragment,
    findInsertionOffset,
    applyInsertions,
    isSubsequence,
    isPathInsideDirectory,
    runVisualRetrofit,
};
