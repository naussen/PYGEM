// src/utils/contentProcessor.js
// Utilitário para processamento de conteúdo: remoção de módulos e geração de índice

const fs = require('fs');
const path = require('path');
const { isPredominantlyUppercaseTitle } = require('./validation');

const EDITORIAL_TITLE_ACRONYMS = new Set([
    'AFO', 'CIDE', 'CLT', 'CPC', 'CPP', 'CTN', 'CVM', 'DRE', 'FRF',
    'ICMS', 'ISS', 'LDO', 'LINDB', 'LOA', 'LRF', 'NBC', 'PPA', 'RT',
    'STF', 'STJ', 'TA', 'TCE', 'TCU', 'TI', 'DC', 'DCs',
]);

function normalizeEditorialHeadingTitle(title) {
    const words = String(title || '').split(/(\s+)/);
    let firstWord = true;
    return words.map((word) => {
        if (/^\s+$/.test(word) || !word) return word;

        const match = word.match(/^(\W*)([\p{L}\p{N}]+)(\W*)$/u);
        if (!match) return word;

        const [, prefix, core, suffix] = match;
        const upperCore = core.toLocaleUpperCase('pt-BR');
        let normalizedCore;
        if (EDITORIAL_TITLE_ACRONYMS.has(upperCore) || /\d/.test(core)) {
            normalizedCore = upperCore;
        } else {
            const lowerCore = core.toLocaleLowerCase('pt-BR');
            normalizedCore = `${lowerCore.charAt(0).toLocaleUpperCase('pt-BR')}${lowerCore.slice(1)}`;
        }

        if (!firstWord && /^(a|as|o|os|e|de|da|das|do|dos|em|na|nas|no|nos|para|por)$/i.test(core)) {
            normalizedCore = core.toLocaleLowerCase('pt-BR');
        }
        firstWord = false;
        return `${prefix}${normalizedCore}${suffix}`;
    }).join('');
}

function normalizeUppercaseHeadings(content) {
    const normalizedLines = String(content || '')
        .replace(/\bDireitorias\b/g, 'Diretorias')
        .replace(/\bdireitorias\b/g, 'diretorias')
        .replace(/\bApose\s+Ntadoria\b/g, 'Aposentadoria')
        .split('\n').map((line) => {
        const match = line.match(/^(\s*#{1,6}\s+)(.+?)(\s*#*\s*)$/);
        if (!match || !isPredominantlyUppercaseTitle(match[2])) return line;
        return `${match[1]}${normalizeEditorialHeadingTitle(match[2])}${match[3]}`;
        });

    let documentHeadingKey = null;
    normalizedLines.forEach((line, index) => {
        const match = line.match(/^(\s*)#(?!#)\s+(.+?)\s*$/);
        if (!match) return;

        const key = match[2]
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('pt-BR')
            .replace(/\s+/g, ' ')
            .trim();
        if (!documentHeadingKey) {
            documentHeadingKey = key;
            return;
        }
        normalizedLines[index] = key === documentHeadingKey
            ? ''
            : `${match[1]}## ${match[2]}`;
    });

    const seenLevelTwoTitles = new Set();
    normalizedLines.forEach((line, index) => {
        const match = line.match(/^(\s*)##(?!#)\s+(.+?)\s*$/);
        if (!match) return;
        const key = match[2]
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('pt-BR')
            .replace(/\s+/g, ' ')
            .trim();
        if (seenLevelTwoTitles.has(key)) {
            normalizedLines[index] = `${match[1]}### ${match[2]}`;
            return;
        }
        seenLevelTwoTitles.add(key);
    });

    normalizedLines.forEach((line, index) => {
        if (!/^\s*##(?!#)\s+\S/.test(line)) return;
        const nextIndex = normalizedLines.findIndex((candidate, candidateIndex) => (
            candidateIndex > index && candidate.trim()
        ));
        if (nextIndex >= 0 && /^\s*##(?!#)\s+\S/.test(normalizedLines[nextIndex])) {
            normalizedLines[nextIndex] = normalizedLines[nextIndex].replace(/^(\s*)##\s+/, '$1### ');
        }
    });

    return normalizedLines.join('\n');
}

/**
 * Gera índice do conteúdo baseado nos títulos ## e subtítulos ###
 * @param {string} content - Conteúdo do arquivo
 * @returns {string} - Índice formatado
 */
function generateContentIndex(content) {
    const lines = content.split('\n');
    const indexItems = [];
    
    lines.forEach((line, index) => {
        // Detecta títulos ## e subtítulos ### (mais flexível)
        const titleMatch = line.match(/^(#{2,3})\s+(.+)$/);
        if (titleMatch) {
            const level = titleMatch[1].length;
            let title = titleMatch[2].trim()
                .replace(/\*\*/g, '') // Remove negritos
                .replace(/\*/g, '')   // Remove itálicos
                .replace(/`/g, '')    // Remove código inline
                .replace(/"/g, '')    // Remove aspas
                .replace(/'/g, '')    // Remove aspas simples
                .replace(/^\*+/, '')  // Remove asteriscos no início
                .replace(/\*+$/, ''); // Remove asteriscos no final
            
            title = title.trim(); // Remove espaços extras
            
            if (title && title.length > 0) {
                if (level === 2) {
                    indexItems.push(`- ${title}`);
                } else if (level === 3) {
                    indexItems.push(`  - ${title}`);
                }
            }
        }
    });
    
    if (indexItems.length === 0) {
        return '';
    }
    
    return `ÍNDICE\n\n${indexItems.join('\n')}`;
}

/**
 * Remove índice existente do início do arquivo markdown
 * @param {string} content - Conteúdo do arquivo
 * @returns {string} - Conteúdo sem índice
 */
function removeExistingIndex(content) {
    const lines = content.split('\n');
    let indexStart = -1;
    let indexEnd = -1;
    
    // Procurar por "# ÍNDICE" ou "ÍNDICE" no início do arquivo
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Detecta início do índice
        if (line === '# ÍNDICE' || line === 'ÍNDICE') {
            indexStart = i;
            continue;
        }
        
        // Se encontrou início do índice, procurar pelo fim
        if (indexStart !== -1) {
            // O índice termina quando encontra uma linha com "---" ou um título principal (#)
            if (line === '---' || line.match(/^#{1}\s+[^#]/)) {
                indexEnd = line === '---' ? i : i - 1;
                break;
            }
            
            // Ou quando encontra uma linha que não é item de lista nem linha vazia
            if (line && !line.match(/^\s*-/) && !line.match(/^\s*$/) && !line.match(/^#{2,}\s+/)) {
                indexEnd = i - 1;
                break;
            }
        }
    }
    
    // Se encontrou índice, removê-lo
    if (indexStart !== -1) {
        if (indexEnd === -1) {
            indexEnd = lines.length - 1;
        }
        
        // Remove o índice e possíveis linhas vazias subsequentes
        lines.splice(indexStart, indexEnd - indexStart + 1);
        
        // Remove linhas vazias no início do arquivo após a remoção
        while (lines.length > 0 && lines[0].trim() === '') {
            lines.shift();
        }
    }
    
    return lines.join('\n');
}

/**
 * Gera arquivo .txt com índice para um arquivo markdown
 * @param {string} filePath - Caminho do arquivo markdown
 * @param {string} content - Conteúdo do arquivo
 * @param {string|null} outputDirectory - Diretório de saída opcional
 * @returns {Object} - Resultado da operação
 */
function generateIndexFile(filePath, content, outputDirectory = null) {
    try {
        const indexContent = generateContentIndex(content);
        
        if (!indexContent) {
            return {
                success: false,
                message: 'Nenhum título encontrado para gerar índice',
                indexFile: null
            };
        }
        
        // Criar nome do arquivo .txt
        const dir = outputDirectory || path.dirname(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const indexFilePath = path.join(dir, `${baseName}.txt`);
        
        // Escrever arquivo de índice
        fs.writeFileSync(indexFilePath, indexContent, 'utf8');
        
        return {
            success: true,
            message: `Índice gerado: ${path.basename(indexFilePath)}`,
            indexFile: indexFilePath
        };
        
    } catch (error) {
        return {
            success: false,
            message: `Erro ao gerar arquivo de índice: ${error.message}`,
            indexFile: null
        };
    }
}

/**
 * Remove números de módulo dos títulos
 * @param {string} content - Conteúdo do arquivo
 * @returns {string} - Conteúdo com módulos removidos
 */
function removeModuleNumbers(content) {
    // Remove "MÓDULO X:" no início de títulos e limpa formatação extra
    // Aceita tanto MÓDULO quanto MODULO (com e sem acento)
    let processed = content.replace(/^(#{1,6})\s*[*"]*M[ÓO]DULO\s+\d+:\s*([*"]*.*)/gmi, (match, hashes, rest) => {
        // Limpa o resto do título removendo asteriscos extras e formatação problemática
        let cleanTitle = rest.trim();
        
        // Se o título está entre ** no início e fim, manter
        if (cleanTitle.startsWith('**') && cleanTitle.endsWith('**') && cleanTitle.length > 4) {
            // Título válido com negrito
            return `${hashes} ${cleanTitle}`;
        }
        
        // Caso contrário, limpar todos os asteriscos órfãos
        cleanTitle = cleanTitle
            .replace(/^\*+/, '') // Remove asteriscos no início
            .replace(/\*+$/, '') // Remove asteriscos no final
            .trim();
        
        return `${hashes} ${cleanTitle}`;
    });
    
    return processed;
}

/**
 * Aplica todas as melhorias de conteúdo
 * @param {string} content - Conteúdo original
 * @param {Object} options - Opções de processamento
 * @param {string|null} options.indexOutputDirectory - Diretório para o índice, sem alterar a entrada
 * @param {string} filePath - Caminho do arquivo (necessário para gerar .txt)
 * @returns {Object} - Resultado do processamento
 */
function applyContentEnhancements(content, options = {}, filePath = null) {
    const { 
        removeModules = true, 
        generateIndex = true,
        indexOutputDirectory = null,
        logProgress = false 
    } = options;
    
    let processedContent = content;
    const changes = [];
    let indexFileResult = null;
    
    // 1. Remover índice existente se presente
    const contentWithoutIndex = removeExistingIndex(processedContent);
    if (contentWithoutIndex !== processedContent) {
        processedContent = contentWithoutIndex;
        changes.push('Índice existente removido do arquivo');
        if (logProgress) console.log(`    ✅ Índice existente removido do arquivo`);
    }
    
    // 2. Remover números de módulo
    if (removeModules) {
        const contentWithoutModules = removeModuleNumbers(processedContent);
        const moduleChanges = contentWithoutModules !== processedContent;
        if (moduleChanges) {
            processedContent = contentWithoutModules;
            changes.push('Números de módulo removidos');
            if (logProgress) console.log(`    ✅ Números de módulo removidos`);
        } else {
            if (logProgress) console.log(`    ℹ️  Nenhum número de módulo encontrado`);
        }
    }
    
    // 3. Gerar arquivo .txt com índice (se fornecido filePath)
    if (generateIndex && filePath) {
        indexFileResult = generateIndexFile(filePath, processedContent, indexOutputDirectory);
        if (indexFileResult.success) {
            changes.push(indexFileResult.message);
            if (logProgress) console.log(`    ✅ ${indexFileResult.message}`);
        } else {
            if (logProgress) console.log(`    ℹ️  ${indexFileResult.message}`);
        }
    } else if (generateIndex && !filePath) {
        if (logProgress) console.log(`    ⚠️  Caminho do arquivo não fornecido - índice não foi gerado`);
    }
    
    return {
        originalContent: content,
        processedContent: processedContent,
        hasChanges: processedContent !== content,
        changes: changes,
        indexFileResult: indexFileResult,
        stats: {
            originalLength: content.length,
            processedLength: processedContent.length,
            sizeDifference: processedContent.length - content.length
        }
    };
}

module.exports = {
    generateContentIndex,
    normalizeUppercaseHeadings,
    removeModuleNumbers,
    removeExistingIndex,
    generateIndexFile,
    applyContentEnhancements
}; 
