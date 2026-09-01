/**
 * Prepara conteúdo markdown para envio à API e valida/sanitiza respostas.
 */

const IMAGE_DEF_PATTERN = /^(\[image[^\]]*\]:\s*<data:image\/[^>]+>\s*)$/gm;
const DOCUMENT_TITLE_PATTERN = /^@@@?[ \t]+(?!#)(\S.*?)[ \t]*$/;
const MARKDOWN_DOCUMENT_TITLE_PATTERN = /^#(?!#)[ \t]+\S.*?\s*$/;

function isDocumentTitleLine(line) {
    const trimmed = String(line || '').trim();
    return DOCUMENT_TITLE_PATTERN.test(trimmed) || MARKDOWN_DOCUMENT_TITLE_PATTERN.test(trimmed);
}

// Títulos editoriais da série Auditoria. O PYGEM preserva o nome do arquivo,
// mas deve corrigir o metadado @@ quando a fonte vier com espaços inseridos
// dentro das palavras. O escopo por arquivo evita alterar títulos legítimos de
// outros conjuntos de documentos.
const AUDITORIA_DOCUMENT_TITLES = new Map([
    ['001_Auditoria.md', 'Auditoria interna (NBC TI 01)'],
    ['002_Auditoria.md', 'Diferenças entre auditoria interna e externa'],
    ['003_Auditoria.md', 'Requisitos para o exercício da auditoria (princípios éticos)'],
    ['004_Auditoria.md', 'Objetivos gerais do auditor independente'],
    ['005_Auditoria.md', 'Independência'],
    ['006_Auditoria.md', 'Responsabilidade do auditor e da administração'],
    ['007_Auditoria.md', 'Concordância com os termos (NBC TA 210)'],
    ['008_Auditoria.md', 'Supervisão e controle de qualidade da auditoria das DCs'],
    ['009_Auditoria.md', 'Materialidade e relevância'],
    ['010_Auditoria.md', 'Planejamento da auditoria (NBC TA 300)'],
    ['011_Auditoria.md', 'Controles internos'],
    ['012_Auditoria.md', 'Erro e fraude (NBC TA 240 / NBC TI 01)'],
    ['013_Auditoria.md', 'Risco de auditoria'],
    ['014_Auditoria.md', 'Técnicas e procedimentos de auditoria'],
    ['015_Auditoria.md', 'Evidências de auditoria'],
    ['016_Auditoria.md', 'Amostragem'],
    ['017_Auditoria.md', 'Documentação de auditoria – papéis de trabalho (NBC TA 230)'],
    ['018_Auditoria.md', 'Estimativas contábeis (NBC TA 540)'],
    ['019_Auditoria.md', 'Utilização do trabalho de outros profissionais'],
    ['020_Auditoria.md', 'Transações com partes relacionadas (NBC TA 550)'],
    ['021_Auditoria.md', 'Eventos subsequentes (NBC TA 560)'],
    ['022_Auditoria.md', 'Relatório de auditoria (NBC TA 700, 701, 705 e 706)'],
    ['023_Auditoria.md', 'Perícia contábil (apenas itens gerais)'],
    ['024_Auditoria.md', 'Testes em áreas específicas'],
]);

function extractOriginalDocumentTitleLine(content) {
    const firstContentLine = String(content || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .find(line => line.trim());

    if (!firstContentLine || !isDocumentTitleLine(firstContentLine)) return null;
    return firstContentLine.trim();
}

function restoreOriginalDocumentTitle(content, originalTitleLine) {
    const rewritten = String(content || '').trim();
    if (!originalTitleLine) return rewritten;

    const lines = rewritten.split(/\r?\n/);
    const firstContentLineIndex = lines.findIndex(line => line.trim());
    if (
        firstContentLineIndex >= 0
        && isDocumentTitleLine(lines[firstContentLineIndex])
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

function prepareContentForRewrite(content, fileName = null) {
    return {
        ...extractImageDefinitions(content),
        originalDocumentTitleLine: extractOriginalDocumentTitleLine(content),
        fileName,
    };
}

function normalizeInlineTopicMarkers(content) {
    return String(content || '').replace(
        /^([ \t]*)@@@[ \t]+(##(?!#)[ \t]+\S.*)$/gm,
        '$1@@@\n$1$2'
    );
}

function stripStandaloneTechnicalMarkers(content) {
    return String(content || '')
        .replace(/^[ \t]*@@@?[ \t]+(##(?!#)[ \t]+.+)$/gm, '$1')
        .replace(/^[ \t]*@@@?[ \t]+(.+)$/gm, '# $1')
        .replace(/^[ \t]*@@@[ \t]*(?:\r?\n|$)/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeAuditoriaDocumentTitle(content, fileName) {
    const canonicalTitle = AUDITORIA_DOCUMENT_TITLES.get(fileName);
    if (!canonicalTitle) return String(content || '');

    const lines = String(content || '').split(/\r?\n/);
    const titleIndex = lines.findIndex(line => DOCUMENT_TITLE_PATTERN.test(line.trim()));
    if (titleIndex < 0) return String(content || '');

    const marker = lines[titleIndex].trim().startsWith('@@@') ? '@@@' : '@@';
    lines[titleIndex] = `${marker} ${canonicalTitle}`;
    return lines.join('\n');
}

function finalizeRewrittenContent(rewritten, prepared) {
    const normalized = normalizeInlineTopicMarkers(rewritten)
        .split(/\r?\n/)
        .filter((line, index) => index === 0 || !/^#\s+(?:unidade\s+\d+(?:\s+de\s+\d+)?|título)\s*$/i.test(line.trim()))
        .join('\n');
    const titlePreserved = restoreOriginalDocumentTitle(
        normalized,
        prepared.originalDocumentTitleLine
    );
    const normalizedDocumentTitle = normalizeAuditoriaDocumentTitle(
        titlePreserved,
        prepared.fileName
    );
    return restoreImageDefinitions(normalizedDocumentTitle, prepared.imageFooter);
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

    return cleaned
        .replace(/^(#{1,6}\s+)@@@?\s*/gm, '$1')
        .replace(/^#\s+Unidade\s+\d+(?:\s+de\s+\d+)?\s*$/gmi, '');
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
    if (originalLen < 800) return false;
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
    stripStandaloneTechnicalMarkers,
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
