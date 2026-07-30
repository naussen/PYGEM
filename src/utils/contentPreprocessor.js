/**
 * Prepara conteúdo markdown para envio à API e valida/sanitiza respostas.
 */

const IMAGE_DEF_PATTERN = /^(\[image[^\]]*\]:\s*<data:image\/[^>]+>\s*)$/gm;

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
    return extractImageDefinitions(content);
}

function normalizeInlineTopicMarkers(content) {
    return String(content || '').replace(
        /^([ \t]*)@@@[ \t]+(##(?!#)[ \t]+\S.*)$/gm,
        '$1@@@\n$1$2'
    );
}

function finalizeRewrittenContent(rewritten, prepared) {
    const normalized = normalizeInlineTopicMarkers(rewritten);
    return restoreImageDefinitions(normalized, prepared.imageFooter);
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

function isOutputTooShort(original, rewritten, minRatio = 0.75) {
    if (!original || !rewritten) return true;
    const originalLen = original.replace(/\s+/g, ' ').length;
    const rewrittenLen = rewritten.replace(/\s+/g, ' ').length;
    if (originalLen < 500) return rewrittenLen < originalLen * 0.5;
    return rewrittenLen < originalLen * minRatio;
}

function isOutputTooLong(original, rewritten, maxRatio = 3) {
    if (!original || !rewritten) return false;
    const originalLen = original.replace(/\s+/g, ' ').length;
    const rewrittenLen = rewritten.replace(/\s+/g, ' ').length;
    return rewrittenLen > originalLen * maxRatio;
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
    return `${basePrompt}

## CONTEXTO DESTE BLOCO
- Este é o bloco ${blockIndex} de ${totalBlocks} do mesmo documento.
- Reescreva TODO o conteúdo deste bloco por completo.
- NÃO omita nenhuma seção, parágrafo ou tabela presente neste bloco.
- Se este bloco começar no meio de um tópico iniciado no bloco anterior, continue diretamente o conteúdo: NÃO repita nem invente o marcador @@@ ou o título ## desse tópico.
- Preserve referências de imagem como \`![][imageN]\` exatamente como aparecem.
- Entregue SOMENTE o markdown reescrito em português, sem comentários meta.`;
}

module.exports = {
    prepareContentForRewrite,
    finalizeRewrittenContent,
    normalizeInlineTopicMarkers,
    extractImageDefinitions,
    restoreImageDefinitions,
    sanitizeModelOutput,
    isThinkingLeak,
    isOutputTooShort,
    isOutputTooLong,
    extractFinishReason,
    getBlockPrompt,
};
