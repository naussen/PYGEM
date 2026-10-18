#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const inputDir = process.argv[2];
const outputDir = process.argv[3];
const onlyGroup = process.argv.includes('--group') ? process.argv[process.argv.indexOf('--group') + 1] : null;
const onlyBatch = process.argv.includes('--batch') ? Number(process.argv[process.argv.indexOf('--batch') + 1]) : null;
const skipBatch = process.argv.includes('--skip-batch') ? Number(process.argv[process.argv.indexOf('--skip-batch') + 1]) : null;
const startIndex = process.argv.includes('--start-index') ? Number(process.argv[process.argv.indexOf('--start-index') + 1]) : 1;
const chunkSize = process.argv.includes('--chunk-size') ? Number(process.argv[process.argv.indexOf('--chunk-size') + 1]) : 2;
const shardArg = process.argv.includes('--shard') ? process.argv[process.argv.indexOf('--shard') + 1] : null;
const shard = shardArg ? shardArg.split('/').map(Number) : null;
if (!inputDir || !outputDir || !process.env.GOOGLE_CLOUD_PROJECT) throw new Error('Entrada, saída e projeto Vertex obrigatórios');
if (shard && (shard.length !== 2 || shard[0] < 1 || shard[0] > shard[1] || shard[1] > 8)) throw new Error('Shard inválido');
if (startIndex < 1 || ![1, 2, 3, 4, 5].includes(chunkSize)) throw new Error('Índice ou tamanho de bloco inválido');
const ai = new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || 'global', apiVersion: 'v1' });
const model = 'gemini-3.1-pro-preview';
const auditDir = path.join(outputDir, 'auditoria_pro');
const original = new Map();
for (const name of fs.readdirSync(inputDir).filter(name => name.endsWith('.json') && name !== 'relatorio_validacao.json')) {
    const data = JSON.parse(fs.readFileSync(path.join(inputDir, name), 'utf8'));
    for (const q of data.questions) {
        if (original.has(q.external_id)) throw new Error(`ID duplicado na origem: ${q.external_id}`);
        original.set(q.external_id, q);
    }
}

function atomicJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(temp, file);
}

function parseResponse(value) {
    const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Resposta sem JSON');
    const data = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(data.items)) throw new Error('Resposta sem items');
    return data.items;
}

async function check(items) {
    const prompt = [
        'Revise RIGOROSAMENTE cada comentário de questão brasileira como auditor independente, em 18/10/2026. Pesquise na internet, preferindo legislação, atos normativos e gabaritos oficiais. Confira cada artigo/parágrafo/inciso e URL citados, sua vigência atual, eventuais revogações, ressalvas, respostas e contas. Detecte afirmações não demonstradas, extrapolações, erro de cálculo, comentários sobre questão anulada/duvidosa, falta de aviso 🔴 para norma antiga, linguagem pessoal e ausência de imagem de cálculo quando há contas. Não aceite citações só porque parecem plausíveis. Se não conseguir verificar uma afirmação essencial, approve=false. Responda apenas JSON válido: {"items":[{"id":"...","approve":true,"reason":"...","needs_red_update":false,"official_urls":["..."]}]}. Um resultado para cada ID.',
        JSON.stringify(items),
    ].join('\n\n');
    for (let attempt = 1; attempt <= 7; attempt += 1) {
        try {
            const response = await ai.models.generateContent({ model, contents: prompt,
                config: { temperature: 0.1, maxOutputTokens: 8192,
                    httpOptions: { timeout: 120000 }, tools: [{ googleSearch: {} }],
                    thinkingConfig: { thinkingLevel: 'MEDIUM' } } });
            const reviewed = parseResponse(response.text);
            const ids = new Set(items.map(item => item.id));
            if (reviewed.length !== ids.size || reviewed.some(item => !ids.has(item.id)) ||
                new Set(reviewed.map(item => item.id)).size !== ids.size) throw new Error('IDs da auditoria incompletos');
            if (reviewed.some(item => typeof item.approve !== 'boolean' ||
                typeof item.reason !== 'string' || !item.reason.trim())) throw new Error('Avaliação de auditoria inválida');
            const urls = [...new Set((response.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
                .map(chunk => chunk.web?.uri).filter(Boolean))];
            return { items: reviewed, grounding_urls: urls,
                search_suggestions_html: response.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent || null,
                usage_metadata: response.usageMetadata || null };
        } catch (error) {
            if (/403|401|PERMISSION_DENIED/i.test(String(error))) throw error;
            const capacityError = /429|RESOURCE_EXHAUSTED|503|504/i.test(String(error));
            if (attempt === (capacityError ? 7 : 3)) throw error;
            const delay = capacityError ? Math.min(60000, 5000 * 2 ** (attempt - 1)) : attempt * 5000;
            await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 2000)));
        }
    }
}

async function checkPartitioned(items) {
    try {
        return await check(items);
    } catch (error) {
        if (items.length === 1 || /403|401|429|PERMISSION_DENIED|RESOURCE_EXHAUSTED/i.test(String(error))) throw error;
        const middle = Math.floor(items.length / 2);
        const left = await checkPartitioned(items.slice(0, middle));
        const right = await checkPartitioned(items.slice(middle));
        return {
            items: [...left.items, ...right.items],
            grounding_urls: [...new Set([...left.grounding_urls, ...right.grounding_urls])],
            search_suggestions_html: [left.search_suggestions_html, right.search_suggestions_html].filter(Boolean).join('\n'),
            usage_metadata: {
                promptTokenCount: (left.usage_metadata?.promptTokenCount || 0) + (right.usage_metadata?.promptTokenCount || 0),
                candidatesTokenCount: (left.usage_metadata?.candidatesTokenCount || 0) + (right.usage_metadata?.candidatesTokenCount || 0),
                thoughtsTokenCount: (left.usage_metadata?.thoughtsTokenCount || 0) + (right.usage_metadata?.thoughtsTokenCount || 0),
                totalTokenCount: (left.usage_metadata?.totalTokenCount || 0) + (right.usage_metadata?.totalTokenCount || 0),
            },
        };
    }
}

async function main() {
    const groups = fs.readdirSync(outputDir).filter(name => name.startsWith('lotes') &&
        fs.statSync(path.join(outputDir, name)).isDirectory() && (!onlyGroup || name === `lotes_${onlyGroup}` || name === onlyGroup));
    for (const group of groups) {
        const files = fs.readdirSync(path.join(outputDir, group)).filter(name => /^\d{4}\.json$/.test(name)).sort();
        for (const name of files) {
            const number = Number(name.slice(0, 4));
            if (onlyBatch && onlyBatch !== number) continue;
            if (skipBatch && skipBatch === number) continue;
            if (shard && (number - 1) % shard[1] !== shard[0] - 1) continue;
            const batch = JSON.parse(fs.readFileSync(path.join(outputDir, group, name), 'utf8'));
            const active = batch.questions.filter(q => q.status === 'comentada');
            for (let i = startIndex - 1; i < active.length; i += chunkSize) {
                const portion = active.slice(i, i + chunkSize);
                const source = portion.map(result => {
                    const q = original.get(result.external_id);
                    if (!q) throw new Error(`Origem ausente: ${result.external_id}`);
                    return { id: result.external_id, disciplina: q.subject, ano: q.exam_year,
                        enunciado: q.statement_markdown, alternativas: q.options,
                        gabarito: result.correct_option_label, comentario: result.comment_markdown,
                        dispositivo: result.legal_basis, alerta: result.outdated_notice,
                        calculo: result.calculation_steps, imagem_calculo: result.calculation_image || null };
                });
                const hash = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
                const file = path.join(auditDir, group, `${name.slice(0, 4)}_${String(i + 1).padStart(2, '0')}.json`);
                if (fs.existsSync(file)) {
                    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
                    if (saved.input_sha256 === hash) {
                        console.log(`${group}/${name} item ${i + 1}: já auditado`);
                        continue;
                    }
                    fs.renameSync(file, `${file}.stale-${Date.now()}`);
                    console.error(`Auditoria obsoleta preservada: ${group}/${name} item ${i + 1}`);
                }
                const result = await checkPartitioned(source);
                atomicJson(file, { schema_version: 'pro-questions/audit-pro/v1', model,
                    input_sha256: hash, batch: `${group}/${name}`, ...result });
                console.log(`${group}/${name} item ${i + 1}: ${result.items.filter(item => item.approve).length}/${source.length} aprovados`);
            }
        }
    }
}

main().catch(error => { console.error(`Falha na auditoria: ${error.message}`); process.exitCode = 1; });
