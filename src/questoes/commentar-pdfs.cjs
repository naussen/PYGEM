#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const inputDir = process.argv[2];
const outputDir = process.argv[3];
const onlyBatch = process.argv.includes('--batch') ? Number(process.argv[process.argv.indexOf('--batch') + 1]) : null;
const reconciliationFile = process.argv.includes('--reconciled') ? process.argv[process.argv.indexOf('--reconciled') + 1] : null;
const revalidate = process.argv.includes('--revalidate');
const onlyExistingFinal = process.argv.includes('--only-existing-final');
if (onlyExistingFinal && !revalidate) throw new Error('--only-existing-final exige --revalidate');
const group = process.argv.includes('--group') ? process.argv[process.argv.indexOf('--group') + 1] : null;
if (group && !/^[a-z0-9_-]+$/i.test(group)) throw new Error('Grupo inválido');
const shardOption = process.argv.includes('--shard') ? process.argv[process.argv.indexOf('--shard') + 1] : null;
const shardParts = shardOption ? shardOption.split('/').map(Number) : null;
if (shardParts && (shardParts.length !== 2 || shardParts[0] < 1 || shardParts[0] > shardParts[1] || shardParts[1] > 8)) {
    throw new Error('Use --shard N/T com 1 <= N <= T <= 8');
}
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const reviewModel = process.env.PYGEM_REVIEW_MODEL || 'gemini-3.5-flash';
const reviewDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
if (!inputDir || !outputDir || !project) {
    console.error('Uso: GOOGLE_CLOUD_PROJECT=... node src/questoes/commentar-pdfs.cjs <entrada> <saida> [--batch N]');
    process.exit(2);
}

const ai = new GoogleGenAI({ vertexai: true, project, location, apiVersion: 'v1' });
const batchDir = path.join(outputDir, group ? `lotes_${group}` : (reconciliationFile ? 'lotes_reconciliados' : 'lotes'));
fs.mkdirSync(batchDir, { recursive: true });

function atomicJson(file, value) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseResponse(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Resposta Vertex sem objeto JSON');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed.items)) throw new Error('Resposta Vertex sem items');
    return parsed;
}

function statementForReview(q) {
    if (!q.external_id.startsWith('pdf:dpf14_009_01:')) {
        if (/\bJUSTIFICATIVA\s+[–—-]\s+/u.test(q.statement_markdown)) {
            throw new Error(`Justificativa oficial não tratada: ${q.external_id}`);
        }
        return q.statement_markdown;
    }
    const parts = q.statement_markdown.split(/\s+JUSTIFICATIVA\s+[–—-]\s+/u);
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
        throw new Error(`Justificativa oficial não separável: ${q.external_id}`);
    }
    return parts[0].trimEnd();
}

function sourceQuestion(q, includeKey) {
    return {
        id: q.external_id,
        disciplina: q.subject,
        ano: q.exam_year,
        banca: q.exam_board,
        enunciado: statementForReview(q),
        alternativas: q.options.map(o => ({ label: o.label, text: o.body_markdown })),
        ...(includeKey ? { gabarito: q.correct_option_label } : {}),
    };
}

function groundingUrls(response) {
    const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    return [...new Set(chunks.map(chunk => chunk?.web?.uri).filter(Boolean))];
}

function searchSuggestions(response) {
    return response?.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent || null;
}

async function callVertex(prompt, grounded, selectedModel, deepReview) {
    for (let attempt = 1; attempt <= 7; attempt += 1) {
        try {
            const response = await ai.models.generateContent({
                model: selectedModel,
                contents: prompt.replaceAll('2026-10-17', reviewDate),
                config: {
                    temperature: grounded ? 0.3 : 0.1,
                    maxOutputTokens: 32768,
                    httpOptions: { timeout: 180000 },
                    ...(deepReview ? { thinkingConfig: { thinkingLevel: 'HIGH' } } : {}),
                    ...(grounded ? { tools: [{ googleSearch: {} }] } : { responseMimeType: 'application/json' }),
                },
            });
            if (!response.text) {
                const finish = response?.candidates?.[0]?.finishReason || response?.promptFeedback?.blockReason || 'sem_motivo';
                throw new Error(`Resposta Vertex vazia (${finish})`);
            }
            const result = parseResponse(response.text);
            return { result, grounding_urls: groundingUrls(response),
                search_suggestions_html: searchSuggestions(response), model: selectedModel,
                usage_metadata: response.usageMetadata || null };
        } catch (error) {
            if (/403|401|PERMISSION_DENIED|UNAUTHENTICATED/i.test(String(error))) throw error;
            const capacityError = /429|RESOURCE_EXHAUSTED|503|504/i.test(String(error));
            if (attempt === (capacityError ? 7 : 3)) throw error;
            const delay = capacityError ? Math.min(60000, 5000 * 2 ** (attempt - 1)) : attempt * 5000;
            const category = /429|RESOURCE_EXHAUSTED/i.test(String(error)) ? '429' :
                /503|504|DEADLINE_EXCEEDED/i.test(String(error)) ? 'prazo/capacidade' : 'resposta_invalida';
            console.error(`Vertex ${category}; tentativa ${attempt}; nova tentativa em ${Math.round(delay / 1000)} s`);
            await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 2000)));
        }
    }
}

async function callVertexPartitioned(prompt, grounded, selectedModel, deepReview) {
    const separator = prompt.lastIndexOf('\n\n');
    const prefix = prompt.slice(0, separator);
    const items = JSON.parse(prompt.slice(separator + 2));
    if (!Array.isArray(items)) throw new Error('Prompt sem lista de questões');
    async function runChunk(chunk) {
        try {
            return [await callVertex(`${prefix}\n\n${JSON.stringify(chunk)}`, grounded, selectedModel, deepReview)];
        } catch (error) {
            if (chunk.length === 1 || /403|401|429|PERMISSION_DENIED|RESOURCE_EXHAUSTED/i.test(String(error))) throw error;
            const middle = Math.floor(chunk.length / 2);
            return [...await runChunk(chunk.slice(0, middle)), ...await runChunk(chunk.slice(middle))];
        }
    }
    const parts = [];
    for (let offset = 0; offset < items.length; offset += 5) {
        const chunk = items.slice(offset, offset + 5);
        parts.push(...await runChunk(chunk));
    }
    return {
        result: { items: parts.flatMap(part => part.result.items) },
        grounding_urls: [...new Set(parts.flatMap(part => part.grounding_urls))],
        search_suggestions_html: parts.map(part => part.search_suggestions_html).filter(Boolean).join('\n'),
        model: selectedModel,
        usage_metadata: {
            promptTokenCount: parts.reduce((sum, part) => sum + (part.usage_metadata?.promptTokenCount || 0), 0),
            candidatesTokenCount: parts.reduce((sum, part) => sum + (part.usage_metadata?.candidatesTokenCount || 0), 0),
            thoughtsTokenCount: parts.reduce((sum, part) => sum + (part.usage_metadata?.thoughtsTokenCount || 0), 0),
            totalTokenCount: parts.reduce((sum, part) => sum + (part.usage_metadata?.totalTokenCount || 0), 0),
        },
    };
}

function indexItems(stage, questions) {
    const ids = new Set(questions.map(q => q.external_id));
    const found = new Map();
    for (const item of stage.result.items) {
        if (!ids.has(item.id) || found.has(item.id)) throw new Error('ID inesperado ou duplicado na resposta Vertex');
        found.set(item.id, item);
    }
    if (found.size !== questions.length) throw new Error(`Lote incompleto: ${found.size}/${questions.length}`);
    return found;
}

function legalSubject(subject) {
    return /direito|legisla|jur[ií]dic|constitucional|tr[aâ]nsito|previdenci/i.test(subject || '');
}

function quantitativeSubject(subject) {
    return /matem[aá]tica|racioc[ií]nio l[oó]gico|estat[ií]stica|contabilidade|financeira|or[cç]ament[aá]ria|f[ií]sica|qu[ií]mica/i.test(subject || '');
}

function requiresCalculationImage(q) {
    if (!quantitativeSubject(q.subject)) return false;
    const statement = q.statement_markdown || '';
    return /R\$|\d[\d.,]*\s*(?:%|m²|m\b|km|kg|horas?|dias?|anos?|meses?)|\b(?:calcule|calcular|c[aá]lculo|juros|taxa|probabilidade|propor[cç][aã]o|equa[cç][aã]o|per[ií]metro|[aá]rea|volume|montante)\b/i.test(statement);
}

function normalizedContent(value, q, auditNotice) {
    if (!value) return value;
    let comment = String(value.comment_markdown || '').trim();
    if (value.legal_basis?.reference && !/dispositivo legal/i.test(comment)) {
        comment += `\n\n**Dispositivo legal**\n\n[${value.legal_basis.reference}](${value.legal_basis.official_url})`;
    }
    const notice = value.outdated_notice || auditNotice;
    if (notice && !comment.includes('🔴')) {
        comment = `🔴 **DESATUALIZADO:** ${notice}\n\n${comment}`;
    }
    return { ...value, comment_markdown: comment };
}

function validComment(value, q) {
    const comment = String(value?.comment_markdown || '').trim();
    if (comment.length < 140 || comment.length > 6000) return 'comentario_ausente_ou_tamanho_invalido';
    if (/\bvoc[eê]\b|\b(?:podemos|devemos|temos|obtemos|sabemos|observamos|verificamos|conclu[ií]mos|notamos|percebemos|considere|observe|veja|note)\b|\b(?:[eé]|seria|parece|torna-se)\s+(?:f[aá]cil|dif[ií]cil|complex[oa])\b/i.test(comment)) return 'linguagem_inadequada';
    if (legalSubject(q.subject) && !value?.legal_basis) return 'dispositivo_legal_ausente';
    if (value?.legal_basis && !/dispositivo legal/i.test(comment)) return 'dispositivo_legal_ausente';
    if (value?.legal_basis && !/^https?:\/\/[^/]+\.(?:gov\.br|jus\.br|leg\.br|mp\.br)(?:\/|$)/i.test(value.legal_basis.official_url || '')) return 'fonte_legal_nao_oficial';
    if (value?.outdated_notice && !/🔴/.test(comment)) return 'alerta_vermelho_ausente';
    if (requiresCalculationImage(q) && (!Array.isArray(value?.calculation_steps) || !value.calculation_steps.length)) return 'memoria_de_calculo_ausente';
    return null;
}

async function stage(file, prompt, grounded, selectedModel = model, deepReview = false, expected = null) {
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    const requiresCleanInput = expected?.some(q => q.external_id.startsWith('pdf:dpf14_009_01:'));
    if (fs.existsSync(file)) {
        const saved = readJson(file);
        try {
            if (saved.prompt_sha256 && saved.prompt_sha256 !== promptHash) throw new Error('prompt alterado');
            if (requiresCleanInput && saved.prompt_sha256 !== promptHash) throw new Error('checkpoint anterior contém justificativa no enunciado');
            if (expected) indexItems(saved, expected);
            return saved;
        } catch (error) {
            fs.renameSync(file, `${file}.invalid-${Date.now()}`);
            console.error(`Checkpoint inconsistente preservado: ${path.basename(file)} (${error.message})`);
        }
    }
    if (onlyExistingFinal) throw new Error(`Checkpoint ausente para validação local: ${path.basename(file)}`);
    const output = await callVertexPartitioned(prompt, grounded, selectedModel, deepReview);
    if (expected) indexItems(output, expected);
    output.prompt_sha256 = promptHash;
    atomicJson(file, output);
    return output;
}

async function processBatch(number, questions) {
    const prefix = path.join(batchDir, String(number).padStart(4, '0'));
    const finalFile = `${prefix}.json`;
    const cleanPf = questions.some(q => q.external_id.startsWith('pdf:dpf14_009_01:'));
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(questions) + (cleanPf ? '|pf_statement_sanitized_v1' : '')).digest('hex');
    if (fs.existsSync(finalFile) && !revalidate) {
        const existing = readJson(finalFile);
        if (existing.input_sha256 !== inputHash) throw new Error(`Entrada mudou após geração do lote ${number}`);
        return existing;
    }
    const legal = questions.some(q => legalSubject(q.subject));
    const initial = await stage(`${prefix}.triagem.json`, [
        'Atue como revisor independente de provas brasileiras. Resolva cada questão SEM conhecer gabarito. Examine precisamente a afirmação julgada, inclusive valores semânticos e funções gramaticais distintos da mesma palavra. Use pesquisa na internet para conferir fontes oficiais, anulações, alterações normativas e atualidade até 2026-10-17. Se o enunciado estiver insuficiente, imagem indispensável não fornecida, resposta ambígua, prova anulada, norma incerta ou fonte não verificável, marque uncertain=true. Em matéria jurídica, identifique dispositivo legal exato, se houver, e eventual mudança de vigência. Não invente URL nem texto legal. Responda SOMENTE JSON válido: {"items":[{"id":"...","solved_answer":"C/E/A/B/... ou null","uncertain":false,"reason":"...","legal_basis":{"reference":"...","official_url":"..."} ou null,"outdated_notice":"..." ou null}]}. Um item por ID.',
        JSON.stringify(questions.map(q => sourceQuestion(q, false))),
    ].join('\n\n'), legal, reviewModel, true, questions);
    const triage = indexItems(initial, questions);
    const safe = questions.filter(q => {
        const check = triage.get(q.external_id);
        return !check.uncertain && check.solved_answer === q.correct_option_label;
    });
    let generation = { result: { items: [] }, grounding_urls: [], model };
    let review = { result: { items: [] }, grounding_urls: [], model };
    if (safe.length) {
        generation = await stage(`${prefix}.geracao.json`, [
            'Você é o PYGEM, responsável por elaborar comentários didáticos originais para questões de concurso. Baseie-se no gabarito e na triagem independente. Produza comentário impessoal, sem falar com o leitor, sem qualificar como fácil/difícil/complexo. Explique o raciocínio e por que a resposta é correta; se múltipla escolha, contraste brevemente os erros relevantes. Cada afirmação deve ser sustentada pelo enunciado ou fonte; evite generalizações, inferências sobre intenção de pessoas e consequências sintáticas não necessárias. Destaque pegadinhas e detalhes; inclua macete de resolução apenas se útil. Em Direito, crie seção separada "Dispositivo legal" com referência precisa e URL oficial; não invente transcrição literal. Se a questão ou norma estiver desatualizada, explique o contexto histórico e a situação atual, com aviso 🔴 **DESATUALIZADO:** dentro do comentário. Para exatas, forneça calculation_steps com linhas curtas, suficientes para gerar uma imagem de memória de cálculo; evite fórmulas complexas no comentário. Se perceber dúvida de correção, marque uncertain=true e deixe comment_markdown vazio. Responda SOMENTE JSON válido com {"items":[{"id":"...","uncertain":false,"reason":"...","comment_markdown":"...","legal_basis":{"reference":"...","official_url":"..."} ou null,"outdated_notice":"..." ou null,"calculation_steps":["..."] ou null}]}. Um item por ID.',
            JSON.stringify(safe.map(q => ({ ...sourceQuestion(q, true), triagem: triage.get(q.external_id) }))),
        ].join('\n\n'), legal, model, false, safe);
        const generated = indexItems(generation, safe);
        review = await stage(`${prefix}.revisao.json`, [
            'Atue como revisor rigoroso independente do conteúdo gerado pelo PYGEM. Faça uma checagem linha por linha: cada afirmação do comentário precisa ser necessária e demonstrável pelo texto, gabarito ou fonte oficial. Rejeite exageros semânticos, generalizações indevidas e efeitos gramaticais que não decorrem necessariamente da mudança proposta. Confira enunciado e gabarito, sem racionalizar erro. Verifique coerência jurídica e vigência em 2026-10-17 com fontes oficiais quando cabível, ausência de afirmações inventadas, linguagem impessoal, pegadinhas, macetes pertinentes e passos de cálculo. Se houver dúvida sobre a correção do item, anulação, lei ou cálculo, approve=false. Responda SOMENTE JSON válido: {"items":[{"id":"...","approve":true,"reason":"...","outdated_notice":"..." ou null}]}. Um item por ID.',
            JSON.stringify(safe.map(q => ({ ...sourceQuestion(q, true), comment: generated.get(q.external_id) }))),
        ].join('\n\n'), legal, reviewModel, true, safe);
    }
    const generated = indexItems(generation, safe);
    const reviewed = indexItems(review, safe);
    const result = {
        schema_version: 'pro-questions/commentary-review/v1',
        batch: number,
        input_sha256: inputHash,
        statement_cleaned: cleanPf,
        model,
        review_model: reviewModel,
        usage_metadata: [initial, generation, review].map(stageResult => stageResult.usage_metadata || null),
        generated_at: new Date().toISOString(),
        search_suggestions_html: [initial, generation, review]
            .map(stageResult => stageResult.search_suggestions_html).filter(Boolean),
        questions: questions.map(q => {
            const first = triage.get(q.external_id);
            const audit = reviewed.get(q.external_id);
            const content = normalizedContent(generated.get(q.external_id), q, audit?.outdated_notice);
            let hold = first.uncertain ? `triagem: ${first.reason}` : null;
            if (!hold && first.solved_answer !== q.correct_option_label) hold = `divergencia_gabarito: ${first.solved_answer || 'indefinido'} vs ${q.correct_option_label}`;
            if (!hold && content?.uncertain) hold = `geracao: ${content.reason}`;
            if (!hold && !audit?.approve) hold = `revisao: ${audit?.reason || 'sem aprovação'}`;
            if (!hold) hold = validComment(content, q);
            return {
                external_id: q.external_id,
                correct_option_label: q.correct_option_label,
                status: hold ? 'revisar_sem_comentario' : 'comentada',
                hold_reason: hold,
                comment_markdown: hold ? null : content.comment_markdown,
                legal_basis: hold ? null : content.legal_basis,
                outdated_notice: hold ? null : (content.outdated_notice || audit.outdated_notice || null),
                calculation_steps: hold ? null : content.calculation_steps,
                batch_grounding_urls: [...new Set([...initial.grounding_urls, ...generation.grounding_urls, ...review.grounding_urls])],
            };
        }),
    };
    atomicJson(finalFile, result);
    execFileSync('python', [path.join(__dirname, 'render-calculations.py'), finalFile], { stdio: 'pipe' });
    return readJson(finalFile);
}

async function main() {
    const files = fs.readdirSync(inputDir).filter(name => name.endsWith('.json') && name !== 'relatorio_validacao.json').sort();
    // Gabaritos preliminares podem ser alterados ou anulados no definitivo.
    const allQuestions = files.flatMap(name => readJson(path.join(inputDir, name)).questions);
    let questions;
    if (reconciliationFile) {
        const reconciled = new Map(readJson(reconciliationFile).items
            .filter(item => ['confirmed', 'changed'].includes(item.status) && item.definitive_answer)
            .map(item => [item.external_id, item]));
        questions = allQuestions.filter(q => reconciled.has(q.external_id)).map(q => {
            const item = reconciled.get(q.external_id);
            return {
                ...q,
                correct_option_label: item.definitive_answer,
                source_metadata: { ...q.source_metadata, answer_status: 'definitivo_reconciliado',
                    original_answer: q.correct_option_label, definitive_answer_url: item.official_url },
            };
        });
        if (questions.length !== reconciled.size) throw new Error('Reconciliação contém IDs sem questão de origem');
    } else {
        // Gabaritos preliminares podem ser alterados ou anulados no definitivo.
        questions = allQuestions.filter(q => q.correct_option_label && q.source_metadata?.answer_status === 'definitivo');
    }
    const batches = [];
    for (let index = 0; index < questions.length; index += 10) batches.push(questions.slice(index, index + 10));
    console.log(`PYGEM Vertex AI: ${questions.length} questões em ${batches.length} lotes; modelo ${model}; projeto ${project}; região ${location}`);
    for (let index = 0; index < batches.length; index += 1) {
        if (onlyBatch && onlyBatch !== index + 1) continue;
        if (shardParts && index % shardParts[1] !== shardParts[0] - 1) continue;
        if (onlyExistingFinal && !fs.existsSync(path.join(batchDir, `${String(index + 1).padStart(4, '0')}.json`))) continue;
        const result = await processBatch(index + 1, batches[index]);
        const counts = { comentada: 0, revisar_sem_comentario: 0 };
        for (const item of result.questions) counts[item.status] += 1;
        console.log(`Lote ${index + 1}/${batches.length}: ${counts.comentada} comentadas; ${counts.revisar_sem_comentario} retidas`);
    }
}

main().catch(error => { console.error(`Falha no lote: ${error.message}`); process.exitCode = 1; });
