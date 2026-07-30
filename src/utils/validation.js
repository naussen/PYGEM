const MERMAID_HEADER_PATTERN = /^(?:flowchart\s+(?:TD|TB|BT|LR|RL)|graph\s+(?:TD|TB|BT|LR|RL)|mindmap|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|pie(?:\s+title\b)?|timeline|gitGraph|journey|quadrantChart|xychart-beta|block-beta|C4Context|sankey-beta|architecture-beta|kanban)\b/i;
const MERMAID_EDGE_PATTERN = /(?:-->|---|==>|-\.->|--o|--x)/;
const MAX_MARKDOWN_LINE_LENGTH = 20000;
const MAX_HORIZONTAL_WHITESPACE_RUN = 1000;
const KNOWN_ACRONYMS = new Set([
    'AFO', 'CIDE', 'CLT', 'CPC', 'CPP', 'CTN', 'CVM', 'DRE', 'FRF',
    'ICMS', 'ISS', 'LDO', 'LINDB', 'LOA', 'LRF', 'NBC', 'PPA', 'RT',
    'STF', 'STJ', 'TA', 'TCE', 'TCU', 'TI',
]);

function validateDirectory(dir) {
    const fs = require('fs');
    return fs.existsSync(dir) && fs.lstatSync(dir).isDirectory();
}

function validateFileExtension(fileName) {
    return fileName.endsWith('.txt') || fileName.endsWith('.md');
}

function validatePrompt(prompt) {
    return typeof prompt === 'string' && prompt.trim().length > 0;
}

function findMermaidDelimiterIssue(code) {
    const pairs = { ']': '[', ')': '(', '}': '{' };
    const opening = new Set(['[', '(', '{']);
    const stack = [];
    let quoted = false;

    for (let index = 0; index < code.length; index += 1) {
        const character = code[index];
        const previous = code[index - 1];

        if (character === '"' && previous !== '\\') {
            quoted = !quoted;
            continue;
        }
        if (quoted) continue;

        if (opening.has(character)) {
            stack.push(character);
        } else if (pairs[character]) {
            if (stack.pop() !== pairs[character]) {
                return `delimitador '${character}' sem abertura correspondente`;
            }
        }
    }

    if (quoted) return 'aspas duplas não balanceadas';
    if (stack.length > 0) return `delimitador '${stack[stack.length - 1]}' não fechado`;
    return null;
}

function validateMermaidDiagram(code, blockNumber) {
    const issues = [];
    const normalized = String(code || '').replace(/\r\n?/g, '\n').trim();
    const lines = normalized.split('\n');
    const firstLine = lines.find(line => line.trim())?.trim() || '';
    const label = `bloco Mermaid ${blockNumber}`;

    if (!normalized) return [`${label}: bloco vazio.`];
    if (/\\n/.test(normalized)) {
        issues.push(`${label}: contém a sequência literal \\n; use quebras de linha reais.`);
    }
    if (!MERMAID_HEADER_PATTERN.test(firstLine)) {
        issues.push(`${label}: cabeçalho Mermaid ausente ou não reconhecido.`);
    }

    const delimiterIssue = findMermaidDelimiterIssue(normalized);
    if (delimiterIssue) issues.push(`${label}: ${delimiterIssue}.`);

    if (/^(?:flowchart|graph)\b/i.test(firstLine)) {
        lines.slice(1).forEach((line, index) => {
            const trimmed = line.trim();
            if (!trimmed || /^%%/.test(trimmed)) return;
            if (MERMAID_EDGE_PATTERN.test(trimmed) && /(?:-->|---|==>|-\.->|--o|--x)\s*(?:\|[^|\r\n]*\|)?\s*$/.test(trimmed)) {
                issues.push(`${label}, linha ${index + 2}: aresta sem nó de destino.`);
            }
        });
    }

    return issues;
}

function validateMermaidBlocks(markdown) {
    const issues = [];
    const source = String(markdown || '');
    const openingPattern = /```mermaid[ \t]*(?:\r?\n|$)/gi;
    if (/```[ \t]+mermaid\b/i.test(source)) {
        issues.push('cerca Mermaid usa formato inválido; use ```mermaid em uma linha própria.');
    }
    let blockCount = 0;
    let match;

    while ((match = openingPattern.exec(source)) !== null) {
        blockCount += 1;
        const contentStart = openingPattern.lastIndex;
        const closingIndex = source.indexOf('```', contentStart);

        if (closingIndex === -1) {
            issues.push(`bloco Mermaid ${blockCount}: cerca de código não fechada.`);
            break;
        }

        const code = source.slice(contentStart, closingIndex);
        issues.push(...validateMermaidDiagram(code, blockCount));
        openingPattern.lastIndex = closingIndex + 3;
    }

    return { valid: issues.length === 0, issues, blockCount };
}

function assertValidMermaidContent(markdown) {
    const result = validateMermaidBlocks(markdown);
    if (!result.valid) throw new Error(`Mermaid inválido: ${result.issues.join(' ')}`);
    return markdown;
}

function normalizeTitleWords(title) {
    return String(title || '')
        .replace(/[*_`]/g, '')
        .match(/[\p{L}\p{N}]+/gu) || [];
}

function collectContextualAcronyms(lines) {
    const body = lines
        .filter(line => !/^#{1,6}\s+\S/.test(line.trim()))
        .join('\n');
    return new Set(
        (body.match(/\b[\p{Lu}\d]{2,12}\b/gu) || [])
            .filter(token => /\p{Lu}/u.test(token))
    );
}

function isAllowedUppercaseTitle(title, contextualAcronyms = new Set()) {
    const words = normalizeTitleWords(title);
    return words.length > 0 && words.every(word => (
        KNOWN_ACRONYMS.has(word.toUpperCase())
        || contextualAcronyms.has(word)
        || /^(?:[IVXLCDM]+|\d+)$/i.test(word)
    ));
}

function isPredominantlyUppercaseTitle(title, contextualAcronyms = new Set()) {
    const letters = String(title || '').match(/\p{L}/gu) || [];
    if (letters.length < 2 || isAllowedUppercaseTitle(title, contextualAcronyms)) return false;

    const uppercaseCount = letters.filter(letter => letter === letter.toUpperCase()).length;
    return uppercaseCount / letters.length >= 0.8;
}

function validateMarkdownQuality(markdown) {
    const issues = [];
    const source = String(markdown || '');
    const lines = source.split(/\r?\n/);
    const pathologicalWhitespacePattern = new RegExp(`[\\t ]{${MAX_HORIZONTAL_WHITESPACE_RUN},}`);
    const contextualAcronyms = collectContextualAcronyms(lines);
    const levelTwoTitles = new Set();

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (line.length > MAX_MARKDOWN_LINE_LENGTH) {
            issues.push(
                `linha ${lineNumber}: possui ${line.length} caracteres; limite seguro ${MAX_MARKDOWN_LINE_LENGTH}.`
            );
        }
        if (pathologicalWhitespacePattern.test(line)) {
            issues.push(
                `linha ${lineNumber}: contém uma sequência patológica de espaços horizontais.`
            );
        }

        const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
        if (headingMatch && isPredominantlyUppercaseTitle(headingMatch[1], contextualAcronyms)) {
            issues.push(
                `linha ${lineNumber}: título predominantemente em maiúsculas; use capitalização editorial e preserve apenas siglas.`
            );
        }

        const levelTwoHeading = line.match(/^(?:@@@[ \t]+)?##(?!#)[ \t]+(.+?)\s*#*\s*$/);
        if (levelTwoHeading) {
            const normalizedTitle = levelTwoHeading[1]
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/\s+/g, ' ')
                .trim();
            if (levelTwoTitles.has(normalizedTitle)) {
                issues.push(
                    `linha ${lineNumber}: título principal duplicado: "${levelTwoHeading[1].trim()}".`
                );
            }
            levelTwoTitles.add(normalizedTitle);

            const nextContentLine = lines
                .slice(index + 1)
                .find(candidate => candidate.trim() && !/^@@@\s*$/.test(candidate.trim()));
            const nextHeading = nextContentLine?.trim().match(/^(#{1,6})\s+\S/);
            if (!nextContentLine || (nextHeading && nextHeading[1].length <= 2)) {
                issues.push(
                    `linha ${lineNumber}: título principal sem conteúdo antes da próxima seção: `
                    + `"${levelTwoHeading[1].trim()}".`
                );
            }
        }
    });

    if (/\bDOUTINA\b/i.test(source)) {
        issues.push("erro ortográfico encontrado: use 'doutrina', não 'doutina'.");
    }
    if (/\[ERRO:\s*Não foi possível reescrever o bloco/i.test(source)) {
        issues.push('a saída contém marcador interno de falha de processamento em bloco.');
    }

    return { valid: issues.length === 0, issues };
}

function validateGeneratedContent(markdown) {
    const mermaid = validateMermaidBlocks(markdown);
    const markdownQuality = validateMarkdownQuality(markdown);
    const issues = [...mermaid.issues, ...markdownQuality.issues];

    return {
        valid: issues.length === 0,
        issues,
        mermaid,
        markdownQuality,
    };
}

function assertValidGeneratedContent(markdown) {
    const result = validateGeneratedContent(markdown);
    if (!result.valid) {
        throw new Error(`Conteúdo gerado inválido: ${result.issues.join(' ')}`);
    }
    return markdown;
}

module.exports = {
    validateDirectory,
    validateFileExtension,
    validatePrompt,
    validateMermaidBlocks,
    assertValidMermaidContent,
    validateMarkdownQuality,
    validateGeneratedContent,
    assertValidGeneratedContent,
    isPredominantlyUppercaseTitle,
};
