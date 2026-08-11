const logger = require('../utils/logger');

/**
 * Estima o número de tokens em um texto
 * Aproximação: 1 token ≈ 4 caracteres para português
 * @param {string} text - Texto para contar tokens
 * @returns {number} Número estimado de tokens
 */
function estimateTokens(text) {
    // Aproximação conservadora: 1 token = 3.5 caracteres
    return Math.ceil(text.length / 3.5);
}

function splitOversizedPlainText(text, maxTokens) {
    const maxCharacters = Math.max(1, Math.floor(maxTokens * 3.5));
    const fragments = [];
    let remaining = String(text || '').trim();

    while (estimateTokens(remaining) > maxTokens) {
        const searchStart = Math.floor(maxCharacters * 0.6);
        const window = remaining.slice(searchStart, maxCharacters + 1);
        const newlineBreak = window.lastIndexOf('\n');
        const relativeBreak = newlineBreak >= 0
            ? newlineBreak
            : window.lastIndexOf(' ');
        const breakAt = relativeBreak >= 0
            ? searchStart + relativeBreak
            : maxCharacters;
        fragments.push(remaining.slice(0, Math.max(1, breakAt)).trim());
        remaining = remaining.slice(Math.max(1, breakAt)).trim();
    }

    if (remaining) fragments.push(remaining);
    return fragments;
}

/**
 * Separa Markdown em unidades que podem ser empacotadas sem cortar cercas de
 * codigo, titulos ou paragrafos no meio. Uma cerca isolada maior que o limite
 * permanece inteira: preservar sua sintaxe e mais seguro que satisfazer o alvo.
 */
function createMarkdownSegments(content, maxTokens) {
    const segments = [];
    const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
    let buffer = [];
    let fenceMarker = null;

    const flush = () => {
        const value = buffer.join('\n').trim();
        buffer = [];
        if (!value) return;

        if (estimateTokens(value) <= maxTokens || /^\s*(`{3,}|~{3,})/.test(value)) {
            segments.push(value);
            return;
        }

        segments.push(...splitOversizedPlainText(value, maxTokens));
    };

    for (const line of lines) {
        const trimmed = line.trim();
        const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);

        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!fenceMarker) fenceMarker = marker;
            else if (marker === fenceMarker) fenceMarker = null;
            buffer.push(line);
            continue;
        }

        if (!fenceMarker && /^#{1,6}\s+\S/.test(trimmed) && buffer.some(item => item.trim())) {
            flush();
        }

        buffer.push(line);
        if (!fenceMarker && !trimmed) flush();
    }

    flush();
    return segments;
}

/**
 * Divide o conteúdo em blocos de tamanho aproximado em tokens
 * @param {string} content - Conteúdo a ser dividido
 * @param {number} maxTokens - Máximo de tokens por bloco (padrão: 5000)
 * @returns {string[]} - Array de blocos de conteúdo
 */
function splitContentIntoBlocks(content, maxTokens = 2800) {
    const blocks = [];
    const segments = createMarkdownSegments(content, maxTokens);
    let currentBlock = '';
    let currentTokens = 0;

    logger.info(`Dividindo conteúdo em blocos de até ${maxTokens} tokens`);

    for (const segment of segments) {
        const isHeading = /^#{1,6}\s+\S/.test(segment);
        const segmentTokens = estimateTokens(segment);

        if (isHeading && currentTokens > maxTokens * 0.25 && currentBlock.trim()) {
            blocks.push(currentBlock.trim());
            currentBlock = segment;
            currentTokens = segmentTokens;
            continue;
        }

        const currentIsOrphanHeading = /^#{1,6}\s+[^\n]+$/.test(currentBlock.trim());
        if (
            currentTokens + segmentTokens > maxTokens
            && currentBlock.length > 0
            && !(currentIsOrphanHeading && currentTokens + segmentTokens <= maxTokens * 1.15)
        ) {
            blocks.push(currentBlock.trim());
            currentBlock = segment;
            currentTokens = segmentTokens;
        } else {
            currentBlock = currentBlock ? `${currentBlock}\n\n${segment}` : segment;
            currentTokens = estimateTokens(currentBlock);
        }
    }
    
    // Adiciona o último bloco se não estiver vazio
    if (currentBlock.trim().length > 0) {
        blocks.push(currentBlock.trim());
    }

    // Evita fragmentos residuais minúsculos criados perto do limite. Um título
    // isolado prefere o bloco seguinte; uma continuação textual prefere o anterior.
    for (let index = 0; index < blocks.length && blocks.length > 1; index++) {
        const block = blocks[index];
        if (estimateTokens(block) >= maxTokens * 0.25) continue;

        const headingOnly = /^#{1,6}\s+[^\n]+$/.test(block.trim());
        const directions = headingOnly ? [1, -1] : [-1, 1];
        for (const direction of directions) {
            const neighborIndex = index + direction;
            if (neighborIndex < 0 || neighborIndex >= blocks.length) continue;
            const merged = direction < 0
                ? `${blocks[neighborIndex]}\n\n${block}`
                : `${block}\n\n${blocks[neighborIndex]}`;
            if (estimateTokens(merged) > maxTokens * 1.15) continue;

            const start = Math.min(index, neighborIndex);
            blocks.splice(start, 2, merged);
            index = Math.max(-1, start - 2);
            break;
        }
    }
    
    logger.info(`Conteúdo dividido em ${blocks.length} blocos`);
    
    // Log dos tamanhos dos blocos
    blocks.forEach((block, index) => {
        const tokens = estimateTokens(block);
        logger.info(`Bloco ${index + 1}: ~${tokens} tokens`);
    });
    
    return blocks;
}

/**
 * Aguarda um determinado número de segundos
 * @param {number} seconds - Número de segundos para aguardar
 */
function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

module.exports = {
    estimateTokens,
    createMarkdownSegments,
    splitContentIntoBlocks,
    sleep
};
