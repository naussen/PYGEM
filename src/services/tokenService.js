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

/**
 * Divide o conteúdo em blocos de tamanho aproximado em tokens
 * @param {string} content - Conteúdo a ser dividido
 * @param {number} maxTokens - Máximo de tokens por bloco (padrão: 5000)
 * @returns {string[]} - Array de blocos de conteúdo
 */
function splitContentIntoBlocks(content, maxTokens = 2800) {
    const blocks = [];
    const lines = content.split('\n');
    let currentBlock = '';
    let currentTokens = 0;

    logger.info(`Dividindo conteúdo em blocos de até ${maxTokens} tokens`);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isHeading = /^#{1,3}\s/.test(line);
        const lineTokens = estimateTokens(line + '\n');

        if (isHeading && currentTokens > maxTokens * 0.25 && currentBlock.trim()) {
            blocks.push(currentBlock.trim());
            currentBlock = `${line}\n`;
            currentTokens = lineTokens;
            continue;
        }

        if (currentTokens + lineTokens > maxTokens && currentBlock.length > 0) {
            blocks.push(currentBlock.trim());
            currentBlock = `${line}\n`;
            currentTokens = lineTokens;
        } else {
            currentBlock += `${line}\n`;
            currentTokens += lineTokens;
        }
    }
    
    // Adiciona o último bloco se não estiver vazio
    if (currentBlock.trim().length > 0) {
        blocks.push(currentBlock.trim());
    }

    if (blocks.length > 1) {
        const lastBlock = blocks[blocks.length - 1];
        const previousBlock = blocks[blocks.length - 2];
        const mergedTail = `${previousBlock}\n\n${lastBlock}`;

        if (
            estimateTokens(lastBlock) < maxTokens * 0.25
            && estimateTokens(mergedTail) <= maxTokens
        ) {
            blocks.splice(blocks.length - 2, 2, mergedTail);
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
    splitContentIntoBlocks,
    sleep
};
