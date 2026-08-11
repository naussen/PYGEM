/**
 * Prepara conteúdo markdown para envio à API e valida/sanitiza respostas.
 */

const IMAGE_DEF_PATTERN = /^(\[image[^\]]*\]:\s*<data:image\/[^>]+>\s*)$/gm;
const DOCUMENT_TITLE_PATTERN = /^@@@?[ \t]+(?!#)(\S.*?)[ \t]*$/;

function extractOriginalDocumentTitleLine(content) {
    const firstContentLine = String(content || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .find(line => line.trim());

    if (!firstContentLine || !DOCUMENT_TITLE_PATTERN.test(firstContentLine.trim())) return null;
    return firstContentLine.trim();
}

function restoreOriginalDocumentTitle(content, originalTitleLine) {
    const rewritten = String(content || '').trim();
    if (!originalTitleLine) return rewritten;

    const lines = rewritten.split(/\r?\n/);
    const firstContentLineIndex = lines.findIndex(line => line.trim());
    if (
        firstContentLineIndex >= 0
        && DOCUMENT_TITLE_PATTERN.test(lines[firstContentLineIndex].trim())
    ) {
        lines[firstContentLineIndex] = originalTitleLine;
        return lines.join('\n').trim();
    }

    return `${originalTitleLine}\n${rewritten}`.trim();
}

function extractImageDefinitions(content) {
    const definitions = [];
    let text = content;

    text = text.replace(IMAGE_DEF_PATTERN, (match) => {
        definitions.push(match.trim());
        return '';
    });

    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return {
        text,
        imageFooter: definitions.length > 0 ? definitions.join('\n\n') : '',
    };
}

function restoreImageDefinitions(content, imageFooter) {
    if (!imageFooter) return content.trim();
    const trimmed = content.trim();
    if (trimmed.includes('[image') && trimmed.includes('base64')) {
        return trimmed;
    }
    return `${trimmed}\n\n${imageFooter}`;
}

function prepareContentForRewrite(content) {
    return {
        ...extractImageDefinitions(content),
        originalDocumentTitleLine: extractOriginalDocumentTitleLine(content),
    };
}

function normalizeInlineTopicMarkers(content) {
    return String(content || '').replace(
        /^([ \t]*)@@@[ \t]+(##(?!#)[ \t]+\S.*)$/gm,
        '$1@@@\n$1$2'
    );
}

function finalizeRewrittenContent(rewritten, prepared) {
    const normalized = normalizeInlineTopicMarkers(rewritten);
    const titlePreserved = restoreOriginalDocumentTitle(
        normalized,
        prepared.originalDocumentTitleLine
    );
    return restoreImageDefinitions(titlePreserved, prepared.imageFooter);
}

const THINKING_LEAK_PATTERNS = [
    /\*\s+Wait,\s/i,
    /\*\s+Let's\s+(think|search|verify|look|decode)/i,
    /\*\s+Could it be/i,
    /\*\s+The (user|prompt|base64|text in the)/i,
    /\*\s+Ah!\s/i,
    /\*\s+Let me decode/i,
    /tec\.ec\/s\//i,
    /my database of/i,
    /Let's think:/i,
    /INÍCIO DO CONTEÚDO A REESCREVER/i,
];

function isThinkingLeak(text) {
    if (!text) return false;
    const sample = text.slice(-4000);
    return THINKING_LEAK_PATTERNS.some((pattern) => pattern.test(sample));
}

function sanitizeModelOutput(text) {
    if (!text) return '';

    let cleaned = text.trim();

    const leakStartPatterns = [
        /\n\s*\*\s+Wait,\s/i,
        /\n\s*\*\s+Let's\s+(think|search|verify|look|decode)/i,
        /\n\s*\*\s+Ah!\s/i,
        /\n\s*\*\s+The user provided/i,
        /\n\s*\*\s+Let me decode/i,
    ];

    for (const pattern of leakStartPatterns) {
        const match = cleaned.match(pattern);
        if (match && match.index !== undefined) {
            cleaned = cleaned.substring(0, match.index).trim();
        }
    }

    return cleaned;
}

function isOutputTooShort(original, rewritten, minRatio = 0.4) {
    if (!original || !rewritten) return true;
    const originalLen = original.replace(/\s+/g, ' ').length;
    const rewrittenLen = rewritten.replace(/\s+/g, ' ').length;
    if (originalLen < 800) return rewrittenLen < originalLen * 0.4;
    return rewrittenLen < originalLen * minRatio;
}

function isOutputTooLong(original, rewritten, maxRatio = 6) {
    if (!original || !rewritten) return false;
    const originalLen = original.replace(/\s+/g, ' ').length;
    const rewrittenLen = rewritten.replace(/\s+/g, ' ').length;
    return rewrittenLen > originalLen * maxRatio;
}

/**
 * Detecta loops de geração por repetição exata de linhas ou janelas de texto.
 * Expressões curtas não participam do cálculo para evitar falso positivo em
 * dispositivos legais que repetem vocabulário de forma legítima.
 */
function measureRepetition(text) {
    const source = String(text || '');
    if (source.length < 4000) {
        return { duplicateRatio: 0, duplicateUnits: 0 };
    }

    const normalizedLines = source
        .split(/\r?\n/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => line.length >= 60);
    const windows = [];
    const normalizedText = source.replace(/\s+/g, ' ').trim();
    for (let index = 0; index + 240 <= normalizedText.length; index += 240) {
        windows.push(normalizedText.slice(index, index + 240));
    }

    const units = [...normalizedLines, ...windows];
    const counts = new Map();
    let totalCharacters = 0;
    let duplicateCharacters = 0;
    let duplicateUnits = 0;

    units.forEach(unit => {
        totalCharacters += unit.length;
        const key = unit.toLocaleLowerCase('pt-BR');
        const previousCount = counts.get(key) || 0;
        counts.set(key, previousCount + 1);
        if (previousCount > 0) {
            duplicateCharacters += unit.length;
            duplicateUnits++;
        }
    });

    const duplicateRatio = totalCharacters > 0
        ? duplicateCharacters / totalCharacters
        : 0;

    return { duplicateRatio, duplicateUnits };
}

function detectRepetitionLoop(text, baselineText = '') {
    const source = String(text || '');
    const baseline = String(baselineText || '');
    const measured = measureRepetition(source);
    const baselineMeasured = measureRepetition(baseline);
    const hasPathologicalRepetition = measured.duplicateUnits >= 4
        && measured.duplicateRatio >= 0.18;
    const materiallyWorseThanSource = !baseline
        || (
            source.length > baseline.length * 1.5
            && (
                measured.duplicateRatio >= baselineMeasured.duplicateRatio + 0.1
                || measured.duplicateUnits >= baselineMeasured.duplicateUnits * 1.5 + 4
            )
        );

    return {
        detected: hasPathologicalRepetition && materiallyWorseThanSource,
        duplicateRatio: measured.duplicateRatio,
        duplicateUnits: measured.duplicateUnits,
        baselineDuplicateRatio: baselineMeasured.duplicateRatio,
        baselineDuplicateUnits: baselineMeasured.duplicateUnits,
    };
}

function extractFinishReason(response) {
    try {
        const candidate = response.candidates?.[0];
        return candidate?.finishReason || null;
    } catch {
        return null;
    }
}

function getBlockPrompt(basePrompt, blockIndex, totalBlocks) {
    if (totalBlocks <= 1) return basePrompt;
    return `# REESCRITA DIDÁTICA DE UNIDADE MARKDOWN

Reescreva integralmente a unidade ${blockIndex} de ${totalBlocks} do documento, com linguagem clara, impessoal e fiel. Use somente as informações fornecidas nesta unidade.

## REGRAS OBRIGATÓRIAS
- Preserve todos os conceitos, condições, exceções, valores, dispositivos, exemplos, parágrafos, listas e tabelas da fonte; não invente nem omita conteúdo.
- Mantenha a extensão próxima à da unidade. Não repita informações e não a transforme em um documento completo.
- Preserve a ordem e a hierarquia Markdown dos títulos. Não crie, antecipe, repita nem promova títulos.
- Uma linha inicial no formato \`@@ Título\` ou \`@@@ Título\` é metadado imutável e deve ser copiada literalmente.
- Preserve os marcadores \`@@@\` existentes. Não crie marcador que não esteja sustentado por um título principal presente na unidade.
- Se a unidade começar no meio de um tópico anterior, continue diretamente: não invente nem repita o marcador \`@@@\` ou o título \`##\`.
- Não crie flashcards, Mermaid, mapas, tabelas, quadros, mnemônicos ou exemplos novos. Preserve e reescreva recursos existentes; mnemônicos existentes devem permanecer literais.
- Preserve referências de imagem como \`![][imageN]\` exatamente como aparecem.
- Não inclua raciocínio, planejamento, comentários meta, nome de site/autor ou questões de concurso.
- Entregue somente o Markdown reescrito em português.`;
}

module.exports = {
    prepareContentForRewrite,
    finalizeRewrittenContent,
    extractOriginalDocumentTitleLine,
    restoreOriginalDocumentTitle,
    normalizeInlineTopicMarkers,
    extractImageDefinitions,
    restoreImageDefinitions,
    sanitizeModelOutput,
    isThinkingLeak,
    isOutputTooShort,
    isOutputTooLong,
    detectRepetitionLoop,
    extractFinishReason,
    getBlockPrompt,
};
