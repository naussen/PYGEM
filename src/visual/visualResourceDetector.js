const { validateMermaidBlocks } = require('../utils/validation');

function normalizeKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
        .replace(/[^a-z0-9]+/g, '');
}

function getSectionAtLine(sections, lineNumber) {
    let current = null;
    sections.forEach(section => {
        if (section.line <= lineNumber) current = section;
    });
    return current;
}

function extractSections(lines) {
    const sections = [];
    let fence = null;
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1][0];
            else if (fenceMatch[1][0] === fence) fence = null;
            return;
        }
        const heading = trimmed.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
        if (heading && !fence) {
            sections.push({
                line: index + 1,
                level: heading[0].match(/^#+/)[0].length,
                title: heading[1].trim(),
                key: normalizeKey(heading[1]),
            });
        }
    });
    return sections;
}

function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableRow(line) {
    return /^\s*\|?.+\|.+\|?\s*$/.test(line);
}

function detectTables(lines, sections) {
    const resources = [];
    for (let index = 0; index < lines.length - 1; index += 1) {
        if (!isTableRow(lines[index]) || !isTableSeparator(lines[index + 1])) continue;
        let end = index + 2;
        while (end < lines.length && isTableRow(lines[end]) && lines[end].trim()) end += 1;
        const section = getSectionAtLine(sections, index + 1);
        resources.push({
            resource: 'table',
            line: index + 1,
            endLine: end,
            section: section?.title || null,
            sectionKey: section?.key || null,
            rows: end - index - 2,
            text: lines.slice(index, end).join(' '),
        });
        index = end - 1;
    }
    return resources;
}

function detectMermaid(markdown, lines, sections) {
    const resources = [];
    const pattern = /```mermaid[ \t]*(?:\r?\n|$)([\s\S]*?)```/gi;
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
        const before = markdown.slice(0, match.index);
        const line = before.split(/\r?\n/).length;
        const code = match[1].trim();
        const firstLine = code.split(/\r?\n/).find(value => value.trim())?.trim() || '';
        const type = firstLine.match(/^(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|mindmap|timeline|quadrantChart|gantt)\b/i)?.[1]?.toLowerCase() || 'unknown';
        const section = getSectionAtLine(sections, line);
        resources.push({
            resource: 'mermaid',
            line,
            endLine: line + match[0].split(/\r?\n/).length - 1,
            section: section?.title || null,
            sectionKey: section?.key || null,
            graphType: type,
            code,
            text: code,
        });
    }
    return resources;
}

function detectBlockResources(lines, sections) {
    const resources = [];
    let index = 0;
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        const isQuote = /^>/.test(trimmed);
        const isAdmonition = /^:::\s*(?:\w+)?\s*$/i.test(trimmed);
        if (!isQuote && !isAdmonition) {
            index += 1;
            continue;
        }
        const start = index;
        if (isQuote) {
            while (index + 1 < lines.length && (/^>/.test(lines[index + 1].trim()) || !lines[index + 1].trim())) index += 1;
        } else {
            index += 1;
            while (index < lines.length && !/^:::\s*$/i.test(lines[index].trim())) index += 1;
        }
        const section = getSectionAtLine(sections, start + 1);
        resources.push({
            resource: 'highlight',
            line: start + 1,
            endLine: index + 1,
            section: section?.title || null,
            sectionKey: section?.key || null,
            kind: isQuote ? 'blockquote' : 'admonition',
            text: lines.slice(start, index + 1).join(' '),
        });
        index += 1;
    }

    let markStart = null;
    lines.forEach((line, lineIndex) => {
        const hasMark = /<mark\b[^>]*>[^<]+<\/mark>/i.test(line);
        if (hasMark && markStart == null) markStart = lineIndex;
        if (!hasMark && markStart != null) {
            const section = getSectionAtLine(sections, markStart + 1);
            resources.push({
                resource: 'highlight',
                line: markStart + 1,
                endLine: lineIndex,
                section: section?.title || null,
                sectionKey: section?.key || null,
                kind: 'mark',
                text: lines.slice(markStart, lineIndex).join(' '),
            });
            markStart = null;
        }
    });
    if (markStart != null) {
        const section = getSectionAtLine(sections, markStart + 1);
        resources.push({
            resource: 'highlight',
            line: markStart + 1,
            endLine: lines.length,
            section: section?.title || null,
            sectionKey: section?.key || null,
            kind: 'mark',
            text: lines.slice(markStart).join(' '),
        });
    }
    return resources;
}

function detectMnemonics(lines, sections) {
    const resources = [];
    const seenSections = new Set();
    lines.forEach((line, index) => {
        if (!/\bmnem[oô]nic[oa]?(?:\b|\s*:)/i.test(line)) return;
        const section = getSectionAtLine(sections, index + 1);
        const sectionIdentity = section?.key || `line-${index + 1}`;
        if (seenSections.has(sectionIdentity)) return;
        seenSections.add(sectionIdentity);
        resources.push({
            resource: 'mnemonic',
            line: index + 1,
            endLine: index + 1,
            section: section?.title || null,
            sectionKey: section?.key || null,
            text: line,
        });
    });
    return resources;
}

function detectVisualResources(markdown) {
    const source = String(markdown || '');
    const lines = source.split(/\r?\n/);
    const sections = extractSections(lines);
    const resources = [
        ...detectTables(lines, sections),
        ...detectMermaid(source, lines, sections),
        ...detectBlockResources(lines, sections),
        ...detectMnemonics(lines, sections),
    ].sort((left, right) => left.line - right.line);
    const mermaidValidation = validateMermaidBlocks(source);
    return {
        resources,
        sections,
        counts: resources.reduce((result, item) => {
            result[item.resource] = (result[item.resource] || 0) + 1;
            return result;
        }, {}),
        mermaid: mermaidValidation,
    };
}

module.exports = {
    normalizeKey,
    extractSections,
    detectVisualResources,
};
