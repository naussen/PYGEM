const { GoogleGenAI } = require('@google/genai');
const config = require('../config/runtime');
const logger = require('../utils/logger');
const { splitContentIntoBlocks, estimateTokens, sleep } = require('./tokenService');
const {
    sanitizeModelOutput,
    isThinkingLeak,
    isOutputTooShort,
    isOutputTooLong,
    detectRepetitionLoop,
    extractFinishReason,
    getBlockPrompt,
    stripStandaloneTechnicalMarkers,
} = require('../utils/contentPreprocessor');
const {
    validateGeneratedContent,
    validateSourceHeadingCoverage,
    assertSourceHeadingCoverage,
} = require('../utils/validation');
const { validateVisualCompliance } = require('../visual/visualComplianceValidator');
const { detectVisualResources } = require('../visual/visualResourceDetector');
const { normalizeUppercaseHeadings } = require('../utils/contentProcessor');
const { createRewriteCheckpoint } = require('./rewriteCheckpointService');
let genAI = null;
let recoveryGenAI = null;
let capacityCooldownUntil = 0;
const apiStats = {
    requests: 0,
    apiErrors: 0,
    validationFailures: 0,
    truncatedResponses: 0,
    retries: 0,
    continuations: 0,
    repetitionLoops: 0,
    recoverySubdivisions: 0,
    preservedBlocks: 0,
};

const errorMatches = (error, pattern) => pattern.test(
    `${error?.status || ''} ${error?.code || ''} ${error?.message || ''}`
);
const isAuthenticationError = (error) => errorMatches(error, /401|UNAUTHENTICATED|default credentials|invalid_grant/i);
const isPermissionError = (error) => errorMatches(error, /403|PERMISSION_DENIED/i);
const isQuotaError = (error) => errorMatches(error, /429|RESOURCE_EXHAUSTED|quota|Too Many Requests/i);
const isUnavailableError = (error) => errorMatches(error, /503|UNAVAILABLE|Service Unavailable|overloaded/i);
const isRequestTimeoutError = (error) => errorMatches(
    error,
    /timeout|timed out|DEADLINE_EXCEEDED|AbortError|The operation was aborted/i
);
const isTransientCapacityError = (error) => (
    isQuotaError(error) || isUnavailableError(error) || isRequestTimeoutError(error)
);

const GENERATION_FAILURE = Object.freeze({
    EMPTY: 'empty',
    MAX_TOKENS: 'max_tokens',
    FINISH_REASON: 'finish_reason',
    TOO_SHORT: 'too_short',
    TOO_LONG: 'too_long',
    THINKING_LEAK: 'thinking_leak',
    INVALID_STRUCTURE: 'invalid_structure',
    REPETITION_LOOP: 'repetition_loop',
});

const SHORT_CONTENT_PASSTHROUGH_TOKEN_LIMIT = 200;

function visualLabel(value) {
    return String(value || '')
        .replace(/["`\\[\\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'Tópico';
}

function appendRequiredVisualFallback(markdown, visualTopics = []) {
    const detected = detectVisualResources(markdown);
    const counts = detected.counts;
    const additions = [];
    visualTopics.forEach(topic => {
        const label = visualLabel(topic.canonical_title);
        topic.requirements.forEach(requirement => {
            const missing = Math.max(0, requirement.minimum - (counts[requirement.resource] || 0));
            for (let index = 0; index < missing; index += 1) {
                if (requirement.resource === 'table') {
                    additions.push(`| Elemento de revisão | Organização |\n| --- | --- |\n| ${label} | Consulte as seções correspondentes do tópico |`);
                } else if (requirement.resource === 'mermaid') {
                    additions.push(`\`\`\`mermaid\nflowchart TD\n  A["${label}"]\n\`\`\``);
                } else if (requirement.resource === 'highlight') {
                    additions.push(`> **Atenção:** revise condições, exceções e consequências apresentadas neste tópico.`);
                }
                counts[requirement.resource] = (counts[requirement.resource] || 0) + 1;
            }
        });
    });
    return additions.length > 0 ? `${String(markdown).trim()}\n\n${additions.join('\n\n')}` : markdown;
}

function trimExcessVisualResources(markdown, visualTopics = []) {
    const limits = new Map();
    visualTopics.forEach(topic => topic.requirements.forEach(requirement => {
        const current = limits.get(requirement.resource);
        limits.set(requirement.resource, current == null ? requirement.maximum : Math.min(current, requirement.maximum));
    }));
    const detected = detectVisualResources(markdown);
    const removals = [];
    limits.forEach((maximum, resource) => {
        detected.resources
            .filter(item => item.resource === resource)
            .slice(maximum)
            .forEach(item => removals.push(item));
    });
    if (removals.length === 0) return markdown;
    const lines = String(markdown).split(/\r?\n/);
    removals.sort((left, right) => right.line - left.line).forEach(item => {
        lines.splice(item.line - 1, item.endLine - item.line + 1);
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function shouldPreserveShortSourceAfterThinkingLeak(content, error) {
    return error?.code === 'PYGEM_OUTPUT_INVALID'
        && error?.details?.reason === GENERATION_FAILURE.THINKING_LEAK
        && estimateTokens(content) <= SHORT_CONTENT_PASSTHROUGH_TOKEN_LIMIT;
}

function createRequestBudget(label, maximum = config.retry.maxApiCallsPerRootBlock, parentBudget = null) {
    let used = 0;
    return {
        label,
        maximum,
        get used() {
            return used;
        },
        consume() {
            if (used >= maximum) {
                const error = new Error(
                    `Orçamento de ${maximum} chamadas esgotado para ${label}; `
                    + 'o bloco será preservado sem nova multiplicação de tentativas.'
                );
                error.code = 'PYGEM_REQUEST_BUDGET_EXHAUSTED';
                throw error;
            }
            parentBudget?.consume();
            used++;
            return used;
        },
    };
}

function createPartialRewriteError(failedBlockDetails, totalBlocks) {
    const error = new Error(
        `Arquivo não publicado: ${failedBlockDetails.length} de ${totalBlocks} bloco(s) `
        + 'permaneceram sem reescrita. Os blocos válidos foram salvos no checkpoint; '
        + 'execute novamente para processar somente os pendentes.'
    );
    error.code = 'PYGEM_PARTIAL_REWRITE';
    error.details = failedBlockDetails;
    return error;
}

const RECOVERABLE_FINISH_REASONS = new Set([
    'RECITATION',
    'LANGUAGE',
    'OTHER',
    'FINISH_REASON_UNSPECIFIED',
]);

function isSuccessfulFinishReason(finishReason) {
    return finishReason === 'STOP';
}

/**
 * Reinicializa o cliente da API do Gemini para evitar conflitos entre documentos
 */
const refreshGeminiClient = () => {
    if (!config.hasValidVertexConfig()) {
        genAI = null;
        recoveryGenAI = null;
        return false;
    }

    genAI = new GoogleGenAI({
        vertexai: true,
        project: config.project,
        location: config.location,
        apiVersion: config.apiVersion,
    });
    recoveryGenAI = null;
    logger.info(`Cliente Vertex AI inicializado (projeto: ${config.project}, região: ${config.location})`);
    return true;
};

const getGeminiClient = (location = config.location) => {
    if (location !== config.location) {
        if (location !== config.recoveryLocation) {
            throw new Error(`Localização Vertex AI não configurada para recuperação: ${location}.`);
        }
        if (!recoveryGenAI) {
            recoveryGenAI = new GoogleGenAI({
                vertexai: true,
                project: config.project,
                location,
                apiVersion: config.apiVersion,
            });
            logger.info(
                `Cliente Vertex AI de recuperação inicializado `
                + `(projeto: ${config.project}, região: ${location})`
            );
        }
        return recoveryGenAI;
    }
    if (!genAI && !refreshGeminiClient()) {
        throw new Error('Configuração do Vertex AI incompleta. Verifique GOOGLE_CLOUD_PROJECT e GOOGLE_CLOUD_LOCATION.');
    }
    return genAI;
};

// Adapta o SDK atual à pequena interface de modelo usada pela aplicação.
const getGenerativeModel = ({ model, generationConfig, safetySettings, location }) => ({
    async generateContent(contents) {
        const response = await getGeminiClient(location).models.generateContent({
            model,
            contents,
            config: {
                ...generationConfig,
                safetySettings,
            },
        });

        const normalizedResponse = Object.create(response);
        Object.defineProperty(normalizedResponse, 'text', {
            value: () => typeof response.text === 'function' ? response.text() : (response.text || ''),
        });

        return { response: normalizedResponse };
    },
});

/**
 * Obtém estatísticas de uso da API
 */
const getApiStats = () => {
    return {
        ...apiStats,
        // Mantido temporariamente para consumidores antigos; agora representa
        // somente falhas reais de comunicação com a API.
        errors: apiStats.apiErrors,
        authentication: 'ADC',
        project: config.project,
        location: config.location,
        model: config.model,
        successRate: apiStats.requests > 0
            ? ((apiStats.requests - apiStats.apiErrors) / apiStats.requests * 100).toFixed(2) + '%'
            : '0%'
    };
};

function buildGenerationConfig(overrides = {}, modelName = config.model) {
    const generationConfig = {
        ...config.generationConfig,
        ...overrides,
    };

    if (/^gemini-(?:3|[4-9])(?:\.|-)/.test(modelName)) {
        generationConfig.thinkingConfig = {
            thinkingLevel: config.modelPolicy.gemini3ThinkingLevel,
            includeThoughts: false,
        };
        delete generationConfig.topK;

        if (modelName === 'gemini-3.5-flash-lite') {
            // O Flash-Lite 3.5 ignora amostragem customizada; omitir esses
            // campos evita uma falsa impressão de determinismo configurável.
            delete generationConfig.temperature;
            delete generationConfig.topP;
        }
    }

    return generationConfig;
}

function createModel(overrides = {}, modelName = config.model, location = config.location) {
    return {
        model: getGenerativeModel({
            model: modelName,
            generationConfig: buildGenerationConfig(overrides, modelName),
            safetySettings: config.safetySettings,
            location,
        }),
        modelName,
    };
}

function getRetryAfterMs(error) {
    const headers = error?.response?.headers || error?.headers;
    const rawValue = typeof headers?.get === 'function'
        ? headers.get('retry-after')
        : headers?.['retry-after'];
    if (rawValue == null) return 0;

    const seconds = Number(rawValue);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const retryDate = Date.parse(rawValue);
    return Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : 0;
}

function calculateRequestRetryDelayMs(retryIndex, retryAfterMs = 0, randomValue = Math.random()) {
    const exponentialDelay = Math.min(
        config.retry.requestRetryMaxDelayMs,
        config.retry.requestRetryInitialDelayMs * (2 ** retryIndex)
    );
    const normalizedRandom = Math.min(1, Math.max(0, Number(randomValue) || 0));
    const jitter = exponentialDelay * config.retry.requestRetryJitterRatio * normalizedRandom;
    const localBackoff = Math.min(
        config.retry.requestRetryMaxDelayMs,
        Math.round(exponentialDelay + jitter)
    );
    return Math.max(retryAfterMs, localBackoff);
}

async function waitForCapacityCooldown() {
    const remainingMs = capacityCooldownUntil - Date.now();
    if (remainingMs <= 0) return;
    global.performanceLogger?.recordDelay(remainingMs, 'capacity-cooldown');
    await sleep(remainingMs / 1000);
}

async function generateRewriteOnce(model, modelName, fullPrompt, context = {}) {
    const inputTokens = estimateTokens(fullPrompt);
    const maxRequestRetries = context.maxRequestRetries ?? config.retry.maxRequestRetries;

    for (let requestAttempt = 0; requestAttempt <= maxRequestRetries; requestAttempt++) {
        await waitForCapacityCooldown();
        const budgetCallNumber = context.budget?.consume() ?? null;
        apiStats.requests++;
        const startedAt = Date.now();

        try {
            const result = await model.generateContent(fullPrompt);
            const response = await result.response;
            const finishReason = extractFinishReason(response);
            const text = sanitizeModelOutput(response.text());
            const usageMetadata = response.usageMetadata || {};
            const duration = Date.now() - startedAt;

            global.performanceLogger?.logApiCall({
                endpoint: 'models.generateContent',
                model: modelName,
                inputTokens,
                outputTokens: estimateTokens(text),
                duration,
                success: true,
                attempt: context.attempt,
                requestAttempt: requestAttempt + 1,
                budgetCallNumber,
                workUnitId: context.workUnitId ?? null,
                parentWorkUnitId: context.parentWorkUnitId ?? null,
                recoveryDepth: context.recoveryDepth ?? 0,
                maxOutputTokens: context.maxOutputTokens ?? null,
                continuation: context.continuation || 0,
                finishReason,
                promptTokenCount: usageMetadata.promptTokenCount ?? null,
                candidatesTokenCount: usageMetadata.candidatesTokenCount ?? null,
                thoughtsTokenCount: usageMetadata.thoughtsTokenCount ?? null,
                totalTokenCount: usageMetadata.totalTokenCount ?? null,
                outputLength: text.length,
            });

            return { text, finishReason, usageMetadata };
        } catch (error) {
            apiStats.apiErrors++;
            global.performanceLogger?.logApiCall({
                endpoint: 'models.generateContent',
                model: modelName,
                inputTokens,
                outputTokens: 0,
                duration: Date.now() - startedAt,
                success: false,
                errorMessage: error.message,
                attempt: context.attempt,
                requestAttempt: requestAttempt + 1,
                budgetCallNumber,
                workUnitId: context.workUnitId ?? null,
                parentWorkUnitId: context.parentWorkUnitId ?? null,
                recoveryDepth: context.recoveryDepth ?? 0,
                maxOutputTokens: context.maxOutputTokens ?? null,
                continuation: context.continuation || 0,
            });

            if (!isTransientCapacityError(error)) {
                throw error;
            }
            if (requestAttempt >= maxRequestRetries) {
                const transientType = isQuotaError(error)
                    ? '429'
                    : (isRequestTimeoutError(error) ? 'timeout' : '503');
                const exhaustedError = new Error(
                    `Requisição ao Vertex AI indisponível após ${maxRequestRetries + 1} `
                    + `tentativas da mesma requisição. ${error.message}`
                );
                exhaustedError.code = 'PYGEM_CAPACITY_RETRIES_EXHAUSTED';
                exhaustedError.capacityType = transientType;
                exhaustedError.retryAfterMs = getRetryAfterMs(error);
                exhaustedError.cause = error;
                throw exhaustedError;
            }

            const delayMs = calculateRequestRetryDelayMs(
                requestAttempt,
                getRetryAfterMs(error)
            );
            capacityCooldownUntil = Math.max(capacityCooldownUntil, Date.now() + delayMs);
            apiStats.retries++;
            global.performanceLogger?.recordGenerationEvent('retries');
            const transientType = isQuotaError(error)
                ? '429'
                : (isRequestTimeoutError(error) ? 'timeout' : '503');
            logger.warn(
                `Requisição temporariamente indisponível (${transientType}); `
                + `nova tentativa de requisição em ${(delayMs / 1000).toFixed(1)}s `
                + `(${requestAttempt + 2}/${maxRequestRetries + 1}).`
            );
            console.log(
                `  ⚠️ Vertex AI temporariamente indisponível (${transientType}); aguardando `
                + `${(delayMs / 1000).toFixed(1)}s antes de repetir a mesma requisição...`
            );
        }
    }

    throw new Error('Fluxo de retry de requisição encerrado inesperadamente.');
}

async function generateRewriteWithCapacityFallback(
    primaryModel,
    primaryModelName,
    generationOverrides,
    fullPrompt,
    context
) {
    try {
        return await generateRewriteOnce(primaryModel, primaryModelName, fullPrompt, context);
    } catch (error) {
        const fallbackModelName = config.fallbackModel;
        if (
            error?.code !== 'PYGEM_CAPACITY_RETRIES_EXHAUSTED'
            || !fallbackModelName
            || fallbackModelName === primaryModelName
        ) {
            throw error;
        }

        apiStats.retries++;
        global.performanceLogger?.recordGenerationEvent('retries');
        logger.warn(
            `Capacidade do modelo ${primaryModelName} esgotada; `
            + `tentando o fallback ${fallbackModelName} com o mesmo orçamento.`
        );
        if (error.capacityType === '429') {
            const fallbackCooldownMs = Math.max(
                config.retry.requestRetryInitialDelayMs,
                error.retryAfterMs || 0
            );
            capacityCooldownUntil = Math.max(
                capacityCooldownUntil,
                Date.now() + fallbackCooldownMs
            );
            logger.warn(
                `Aguardando ${(fallbackCooldownMs / 1000).toFixed(1)}s antes do fallback `
                + 'para evitar nova rajada sobre a cota compartilhada.'
            );
        }
        console.log(`  ↪️ Tentando modelo fallback: ${fallbackModelName}...`);
        const { model: fallbackModel } = createModel(generationOverrides, fallbackModelName);
        return generateRewriteOnce(
            fallbackModel,
            fallbackModelName,
            fullPrompt,
            { ...context, maxRequestRetries: 0 }
        );
    }
}

function calculateMaxOutputTokens(
    content,
    maxRatio = config.outputPolicy.maxOutputRatio
) {
    const proportionalBudget = Math.ceil(
        estimateTokens(content)
        * maxRatio
        * config.outputPolicy.maxOutputTokenMultiplier
        + config.outputPolicy.fixedOutputReserveTokens
    );
    const baseBudget = Math.max(
        config.outputPolicy.minOutputTokens,
        proportionalBudget
    );

    return Math.min(
        config.generationConfig.maxOutputTokens,
        config.outputPolicy.maxOutputTokensPerRequest,
        baseBudget
    );
}

function getRetryInstruction(failure) {
    switch (failure?.reason) {
        case GENERATION_FAILURE.MAX_TOKENS:
            return 'A tentativa anterior foi truncada. Produza uma versão completa e concisa em uma única resposta, sem planejamento ou raciocínio interno.';
        case GENERATION_FAILURE.FINISH_REASON:
            return `A tentativa anterior foi interrompida pelo modelo (${failure.finishReason || 'motivo não informado'}). Entregue o Markdown completo, sem reproduzir longos trechos literalmente e sem incluir conteúdo externo.`;
        case GENERATION_FAILURE.TOO_SHORT:
        case GENERATION_FAILURE.EMPTY:
            return 'A tentativa anterior omitiu conteúdo. Preserve todos os conceitos, valores, exemplos e exceções presentes no texto fornecido.';
        case GENERATION_FAILURE.TOO_LONG:
        case GENERATION_FAILURE.REPETITION_LOOP:
            return 'A tentativa anterior expandiu excessivamente o material. Não acrescente conteúdo externo, não repita informações e use recursos didáticos apenas quando indispensáveis.';
        case GENERATION_FAILURE.THINKING_LEAK:
            return 'Entregue exclusivamente o Markdown final, sem planejamento, análise interna ou comentários sobre o processo de reescrita.';
        case GENERATION_FAILURE.INVALID_STRUCTURE:
            return [
                'A tentativa anterior apresentou estrutura Markdown inválida.',
                `Corrija especificamente: ${failure.details}`,
                'Não use HTML. Em especial, substitua cada <br> ou <br/> por uma quebra de linha Markdown ou por linhas separadas em listas e tabelas.',
                'Antes de responder, verifique que nenhum <br>, <br/> ou outra tag HTML permaneceu fora de um bloco Mermaid.',
            ].join(' ');
        default:
            return '';
    }
}

function getContentScaleInstruction(content) {
    const contentTokens = estimateTokens(content);
    if (contentTokens < 500) {
        return [
            '## ESCALA DESTA ENTRADA',
            `Este trecho possui aproximadamente ${contentTokens} tokens.`,
            'Não crie Mermaid, flashcards, tabelas, quadros-resumo ou exemplos novos. '
                + 'Apenas reescreva e organize integralmente o conteúdo fornecido.',
        ].join('\n');
    }
    if (contentTokens < 2000) {
        return [
            '## ESCALA DESTA ENTRADA',
            `Este trecho possui aproximadamente ${contentTokens} tokens.`,
            'Use no máximo um recurso didático opcional e somente se ele for indispensável. '
                + 'Priorize a reescrita completa do conteúdo.',
        ].join('\n');
    }
    return [
        '## ESCALA DESTA ENTRADA',
        `Este trecho possui aproximadamente ${contentTokens} tokens.`,
        'Dimensione os recursos opcionais ao tamanho do trecho e preserve espaço suficiente para concluir todo o conteúdo.',
    ].join('\n');
}

function buildAttemptPrompt(prompt, content, lastFailure) {
    const retryInstruction = getRetryInstruction(lastFailure);
    return [
        prompt,
        getContentScaleInstruction(content),
        retryInstruction ? `## CORREÇÃO DA NOVA TENTATIVA\n${retryInstruction}` : '',
        content,
    ].filter(Boolean).join('\n\n');
}

function replaceLineBreakTagsOutsideMermaid(markdown) {
    let insideMermaid = false;
    return String(markdown || '').split(/\r?\n/).map(line => {
        if (/^\s*```mermaid\s*$/i.test(line)) {
            insideMermaid = true;
            return line;
        }
        if (insideMermaid && /^\s*```\s*$/.test(line)) {
            insideMermaid = false;
            return line;
        }
        if (insideMermaid || !/<br\s*\/?\s*>/i.test(line)) return line;
        return line.includes('|')
            ? line.replace(/<br\s*\/?\s*>/gi, '; ')
            : line.replace(/\s*<br\s*\/?\s*>\s*/gi, '\n');
    }).join('\n');
}

function shouldRewriteInBlocks(contentOrTokens) {
    const tokens = typeof contentOrTokens === 'number'
        ? contentOrTokens
        : estimateTokens(contentOrTokens);
    return tokens > config.processing.singlePassMaxInputTokens;
}

function getRecoverySubdivision(block, error, depth = 0) {
    const recoverableReasons = new Set([
        GENERATION_FAILURE.MAX_TOKENS,
        GENERATION_FAILURE.TOO_LONG,
        GENERATION_FAILURE.REPETITION_LOOP,
        GENERATION_FAILURE.INVALID_STRUCTURE,
        GENERATION_FAILURE.FINISH_REASON,
    ]);
    const blockTokens = estimateTokens(block);

    if (
        error?.code !== 'PYGEM_OUTPUT_INVALID'
        || !recoverableReasons.has(error?.details?.reason)
        || depth >= config.processing.maxBlockSubdivisionDepth
        || blockTokens <= config.processing.minRecoveryBlockTokens
        || (
            error?.details?.reason === GENERATION_FAILURE.FINISH_REASON
            && !RECOVERABLE_FINISH_REASONS.has(error?.details?.finishReason)
        )
    ) {
        return null;
    }

    const recoveryLimit = Math.max(
        config.processing.minRecoveryBlockTokens,
        Math.floor(blockTokens / 2)
    );
    const fragments = splitContentIntoBlocks(block, recoveryLimit);
    if (fragments.length > 1) {
        const lastIndex = fragments.length - 1;
        const tailTokens = estimateTokens(fragments[lastIndex]);
        const mergedTail = `${fragments[lastIndex - 1]}\n\n${fragments[lastIndex]}`;
        if (
            tailTokens < config.processing.minRecoveryBlockTokens
            && estimateTokens(mergedTail) <= recoveryLimit * 1.2
        ) {
            fragments.splice(lastIndex - 1, 2, mergedTail);
        }
    }
    return fragments.length > 1 ? fragments : null;
}

async function waitForValidationRetry(attempt, maxAttempts, delaySeconds) {
    if (attempt >= maxAttempts) return;
    apiStats.retries++;
    global.performanceLogger?.recordGenerationEvent('retries');
    global.performanceLogger?.recordDelay(delaySeconds * 1000, 'validation');
    await sleep(delaySeconds);
}

async function generateValidatedRewrite(content, prompt, options = {}) {
    const maxAttempts = options.maxAttempts ?? config.retry.maxGenerationAttempts;
    const minRatio = options.minOutputRatio ?? 0.75;
    const maxRatio = options.maxOutputRatio ?? config.outputPolicy.maxOutputRatio;
    const label = options.label ?? 'conteúdo';
    const primaryModelName = options.modelName ?? config.model;
    const primaryLocation = options.modelLocation ?? config.location;
    let lastFailure = null;
    let useOutputFallback = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const maxOutputTokens = calculateMaxOutputTokens(content, maxRatio);
        const modelName = useOutputFallback ? config.fallbackModel : primaryModelName;
        const modelLocation = useOutputFallback ? config.location : primaryLocation;
        useOutputFallback = false;
        const generationOverrides = {
            maxOutputTokens,
            ...(attempt > 1 ? { temperature: 0.1 } : {}),
        };
        const { model } = createModel(generationOverrides, modelName, modelLocation);
        const promptToSend = buildAttemptPrompt(prompt, content, lastFailure);
        console.log(`Usando modelo: ${modelName} (${label}, tentativa ${attempt}/${maxAttempts}, limite ${maxOutputTokens} tokens)`);
        const generationExecutor = options.generationExecutor
            || generateRewriteWithCapacityFallback;
        const result = await generationExecutor(
            model,
            modelName,
            generationOverrides,
            promptToSend,
            {
                attempt,
                continuation: 0,
                budget: options.budget,
                workUnitId: options.workUnitId,
                parentWorkUnitId: options.parentWorkUnitId,
                recoveryDepth: options.recoveryDepth,
                maxOutputTokens,
                sourceContent: content,
            }
        );
        const { text: accumulated, finishReason, usageMetadata = {} } = result;
        const repetition = detectRepetitionLoop(accumulated, content);

        if (finishReason === 'MAX_TOKENS') {
            apiStats.truncatedResponses++;
            global.performanceLogger?.recordGenerationEvent('truncatedResponses');
        }

        // MAX_TOKENS também pode encerrar uma expansão ou repetição patológica.
        // Classificar primeiro o conteúdo preserva a causa real para o fallback.
        if (repetition.detected) {
            apiStats.repetitionLoops++;
            global.performanceLogger?.recordGenerationEvent('repetitionLoops');
            lastFailure = {
                reason: GENERATION_FAILURE.REPETITION_LOOP,
                attempt,
                finishReason: finishReason || null,
                details: `repetição de ${(repetition.duplicateRatio * 100).toFixed(1)}% em ${repetition.duplicateUnits} unidades`,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        } else if (isOutputTooLong(content, accumulated, maxRatio)) {
            lastFailure = {
                reason: GENERATION_FAILURE.TOO_LONG,
                attempt,
                finishReason: finishReason || null,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        } else if (finishReason === 'MAX_TOKENS') {
            lastFailure = {
                reason: GENERATION_FAILURE.MAX_TOKENS,
                attempt,
                finishReason,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        } else if (!isSuccessfulFinishReason(finishReason)) {
            lastFailure = {
                reason: GENERATION_FAILURE.FINISH_REASON,
                attempt,
                finishReason: finishReason || 'FINISH_REASON_UNSPECIFIED',
                details: `Motivo de término retornado pelo Vertex AI: ${finishReason || 'não informado'}.`,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        } else if (!accumulated.trim()) {
            lastFailure = {
                reason: GENERATION_FAILURE.EMPTY,
                attempt,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: 0,
                usageMetadata,
            };
        } else if (isThinkingLeak(accumulated)) {
            lastFailure = {
                reason: GENERATION_FAILURE.THINKING_LEAK,
                attempt,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        } else if (isOutputTooShort(content, accumulated, minRatio)) {
            lastFailure = {
                reason: GENERATION_FAILURE.TOO_SHORT,
                attempt,
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        } else {
            const sourceUsesTechnicalMarkers = /^\s*@@@?/m.test(content);
            const normalizedAccumulated = normalizeUppercaseHeadings(
                sourceUsesTechnicalMarkers ? accumulated : stripStandaloneTechnicalMarkers(accumulated)
            );
            const outputValidation = validateGeneratedContent(normalizedAccumulated, {
                sourceMarkdown: content,
            });
            const repairedAccumulated = outputValidation.issues.length > 0
                ? replaceLineBreakTagsOutsideMermaid(normalizedAccumulated)
                : normalizedAccumulated;
            const repairedValidation = repairedAccumulated === normalizedAccumulated
                ? outputValidation
                : validateGeneratedContent(repairedAccumulated, { sourceMarkdown: content });
            const headingCoverage = validateSourceHeadingCoverage(content, repairedAccumulated);
            const visualReady = options.visualTopics?.length > 0
                ? appendRequiredVisualFallback(
                    trimExcessVisualResources(repairedAccumulated, options.visualTopics),
                    options.visualTopics
                )
                : repairedAccumulated;
            const visualCompliance = options.visualTopics?.length > 0
                ? validateVisualCompliance(visualReady, { visualTopics: options.visualTopics })
                : { valid: true, issues: [] };
            if (repairedValidation.valid && headingCoverage.valid && visualCompliance.valid) {
                if (repairedAccumulated !== normalizedAccumulated) {
                    logger.warn(`${label} continha <br> fora de Mermaid; a resposta rejeitada foi recuperada sem HTML.`);
                }
                logger.info(`${label} reescrito com sucesso (${visualReady.length} caracteres)`);
                return visualReady;
            }

            lastFailure = {
                reason: GENERATION_FAILURE.INVALID_STRUCTURE,
                attempt,
                details: [
                    ...repairedValidation.issues,
                    ...headingCoverage.issues,
                    ...visualCompliance.issues.map(issue => issue.message),
                ].join(' '),
                maxOutputTokens,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata,
            };
        }

        apiStats.validationFailures++;
        global.performanceLogger?.recordGenerationEvent('validationFailures');
        logger.warn(`Saída rejeitada em ${label}: ${lastFailure.reason}${lastFailure.details ? ` - ${lastFailure.details}` : ''}`);
        console.log(`  ⚠️ Saída rejeitada em ${label} (${lastFailure.reason}).`);

        const requiresImmediateSubdivision = new Set([
            GENERATION_FAILURE.MAX_TOKENS,
            GENERATION_FAILURE.TOO_LONG,
            GENERATION_FAILURE.REPETITION_LOOP,
            GENERATION_FAILURE.FINISH_REASON,
        ]).has(lastFailure.reason);
        const canTryOutputFallback = requiresImmediateSubdivision
            && attempt < maxAttempts
            && options.allowOutputFallback !== false
            && primaryModelName === config.model
            && modelName === primaryModelName
            && config.fallbackModel
            && config.fallbackModel !== config.model;
        if (canTryOutputFallback) {
            useOutputFallback = true;
            logger.warn(
                `${label} será tentado no modelo fallback ${config.fallbackModel} `
                + 'antes de qualquer subdivisão.'
            );
            console.log(
                `  ↪️ Tentando ${config.fallbackModel} com o mesmo limite antes de subdividir...`
            );
            await waitForValidationRetry(attempt, maxAttempts, 0);
            continue;
        }
        if (requiresImmediateSubdivision) break;

        const validationRetryDelaySeconds = options.validationRetryDelaySeconds
            ?? (lastFailure.reason === GENERATION_FAILURE.TOO_SHORT ? 3 : 1);
        await waitForValidationRetry(attempt, maxAttempts, validationRetryDelaySeconds);
    }

    const finalReason = lastFailure?.reason || 'desconhecido';
    const error = new Error(
        `Falha ao reescrever ${label} após ${maxAttempts} tentativas. `
        + `Última rejeição: ${finalReason}; saída ${lastFailure?.outputLength ?? 0}/${lastFailure?.originalLength ?? content.length} caracteres.`
        + `${lastFailure?.maxOutputTokens ? ` Orçamento final: ${lastFailure.maxOutputTokens} tokens.` : ''}`
        + `${lastFailure?.details ? ` Detalhes: ${lastFailure.details}` : ''}`
    );
    error.code = 'PYGEM_OUTPUT_INVALID';
    error.details = lastFailure;
    throw error;
}

async function rewriteBlockWithRecovery(block, prompt, label, options = {}) {
    const depth = options.depth ?? 0;
    const minOutputRatio = options.minOutputRatio ?? 0.7;
    const workUnitId = options.workUnitId ?? 'unit';
    const basePrompt = options.basePrompt ?? prompt;
    try {
        return await generateValidatedRewrite(block, prompt, {
            label,
            maxAttempts: options.maxAttempts,
            minOutputRatio,
            budget: options.budget,
            workUnitId,
            parentWorkUnitId: options.parentWorkUnitId,
            recoveryDepth: depth,
            generationExecutor: options.generationExecutor,
            visualTopics: depth === 0 ? options.visualTopics : [],
        });
    } catch (error) {
        if (shouldPreserveShortSourceAfterThinkingLeak(block, error)) {
            logger.warn(
                `Bloco curto preservado apÃ³s rejeiÃ§Ã£o thinking_leak `
                + `(atÃ© ${SHORT_CONTENT_PASSTHROUGH_TOKEN_LIMIT} tokens).`
            );
            return block;
        }
        const fragments = getRecoverySubdivision(block, error, depth);
        if (!fragments) {
            const recoveryReasons = new Set([
                GENERATION_FAILURE.MAX_TOKENS,
                GENERATION_FAILURE.TOO_LONG,
                GENERATION_FAILURE.REPETITION_LOOP,
                GENERATION_FAILURE.INVALID_STRUCTURE,
            ]);
            const canUseRecoveryModel = options.allowRecoveryModel !== false
                && error?.code === 'PYGEM_OUTPUT_INVALID'
                && recoveryReasons.has(error?.details?.reason)
                && config.recoveryModel
                && config.recoveryModel !== config.model;
            if (!canUseRecoveryModel) throw error;

            apiStats.retries++;
            global.performanceLogger?.recordGenerationEvent('retries');
            logger.warn(
                `${label} chegou ao menor fragmento recuperável; tentando `
                + `${config.recoveryModel} em ${config.recoveryLocation}.`
            );
            console.log(
                `  ↪️ Fragmento mínimo: recuperação final com `
                + `${config.recoveryModel} (${config.recoveryLocation})...`
            );
            return generateValidatedRewrite(block, prompt, {
                label: `${label}, recuperação final`,
                minOutputRatio,
                maxAttempts: 1,
                modelName: config.recoveryModel,
                modelLocation: config.recoveryLocation,
                allowOutputFallback: false,
                budget: options.budget,
                workUnitId,
                parentWorkUnitId: options.parentWorkUnitId,
                recoveryDepth: depth,
                generationExecutor: options.generationExecutor,
                visualTopics: depth === 0 ? options.visualTopics : [],
            });
        }

        apiStats.recoverySubdivisions++;
        global.performanceLogger?.recordGenerationEvent('recoverySubdivisions');

        logger.warn(
            `${label} será subdividido em ${fragments.length} fragmentos após ${error.details.reason}.`
        );
        console.log(
            `  ↪️ ${label} rejeitado (${error.details.reason}); `
            + `recuperando em ${fragments.length} fragmentos menores...`
        );

        const rewrittenFragments = [];
        for (let index = 0; index < fragments.length; index++) {
            const fragmentLabel = `${label}, fragmento ${index + 1}/${fragments.length}`;
            const childWorkUnitId = `${workUnitId}.${index + 1}`;
            const fragmentPrompt = [
                basePrompt,
                '## RECUPERAÇÃO DE BLOCO',
                `Reescreva somente o fragmento ${index + 1} de ${fragments.length} abaixo. `
                    + 'Não antecipe nem repita os demais fragmentos. '
                    + 'Não crie recursos didáticos novos; preserve somente os já existentes.',
            ].join('\n\n');
            rewrittenFragments.push(
                await rewriteBlockWithRecovery(
                    fragments[index],
                    fragmentPrompt,
                    fragmentLabel,
                    {
                        ...options,
                        depth: depth + 1,
                        minOutputRatio,
                        workUnitId: childWorkUnitId,
                        parentWorkUnitId: workUnitId,
                        basePrompt,
                    }
                )
            );
        }

        const combined = rewrittenFragments.join('\n\n');
        assertSourceHeadingCoverage(block, combined);
        return combined;
    }
}

const geminiService = {
    async generateVisualFragment(prompt, options = {}) {
        if (!config.hasValidVertexConfig()) {
            throw new Error('Configuração do Vertex AI incompleta. Verifique o arquivo .env.');
        }
        const models = [...new Set([config.model, config.fallbackModel].filter(Boolean))];
        let lastError = null;
        for (const modelName of models) {
            try {
                apiStats.requests++;
                const { model } = createModel({
                    temperature: 0.1,
                    maxOutputTokens: Math.min(
                        Number(options.maxOutputTokens) || 2048,
                        config.outputPolicy.maxOutputTokensPerRequest
                    ),
                }, modelName);
                const result = await model.generateContent(prompt);
                const response = await result.response;
                const text = response.text();
                if (!String(text || '').trim()) {
                    throw new Error(`O modelo ${modelName} retornou um fragmento visual vazio.`);
                }
                return text;
            } catch (error) {
                lastError = error;
                apiStats.apiErrors++;
                if (isAuthenticationError(error) || isPermissionError(error)) break;
                logger.warn(`Falha ao gerar fragmento visual com ${modelName}: ${error.message}`);
            }
        }
        if (isAuthenticationError(lastError)) {
            throw new Error('Falha na autenticação ADC. Execute "gcloud auth application-default login".');
        }
        if (isPermissionError(lastError)) {
            throw new Error('Acesso negado pelo Vertex AI. Verifique a API e as permissões IAM do projeto.');
        }
        throw lastError || new Error('Não foi possível gerar o fragmento visual.');
    },

    async rewriteContent(content, prompt, options = {}) {
        try {
            if (!config.hasValidVertexConfig()) {
                throw new Error('Configuração do Vertex AI incompleta. Verifique o arquivo .env.');
            }
            const budget = createRequestBudget('conteúdo em passagem única');
            logger.info('Iniciando reescrita em passagem única com orçamento global de chamadas.');
            return await rewriteBlockWithRecovery(content, prompt, 'conteúdo', {
                budget,
                workUnitId: 'single',
                maxAttempts: estimateTokens(content) <= SHORT_CONTENT_PASSTHROUGH_TOKEN_LIMIT ? 1 : undefined,
                minOutputRatio: 0.75,
                basePrompt: prompt,
                visualTopics: options.visualTopics,
            });
        } catch (error) {
            if (shouldPreserveShortSourceAfterThinkingLeak(content, error)) {
                logger.warn(
                    `Conteúdo curto preservado após rejeição thinking_leak `
                    + `(até ${SHORT_CONTENT_PASSTHROUGH_TOKEN_LIMIT} tokens).`
                );
                return content;
            }
            logger.error(`Falha no fluxo de reescrita: ${error.message}`);
            if (isAuthenticationError(error)) {
                throw new Error('Falha na autenticação ADC. Execute "gcloud auth application-default login" ou configure uma identidade de serviço segura.');
            }
            if (isPermissionError(error)) {
                throw new Error('Acesso negado pelo Vertex AI. Verifique a API Vertex AI e o papel Vertex AI User.');
            }
            if (errorMatches(error, /safety|SAFETY/i)) {
                throw new Error('Conteúdo bloqueado pelas configurações de segurança');
            }
            throw error;
        }
    },

    async rewriteContentInBlocks(content, prompt, fileName, options = {}) {
        try {
            if (!config.hasValidVertexConfig()) {
                throw new Error('Configuração do Vertex AI incompleta. Verifique o arquivo .env.');
            }

            logger.info(`Iniciando processamento em blocos no Vertex AI para arquivo: ${fileName}`);

            const blocks = splitContentIntoBlocks(content, config.processing.blockInputTokens);
            const rewrittenBlocks = [];
            let processedBlocks = 0;
            let blockErrors = 0;
            const failedBlockDetails = [];
            const fileCallLimit = Math.ceil(
                blocks.length * config.retry.maxApiCallsPerFileMultiplier
            ) + config.retry.maxApiCallsPerFileReserve;
            const fileBudget = createRequestBudget(
                `arquivo ${fileName}`,
                fileCallLimit
            );
            const checkpoint = config.checkpoint.enabled
                ? createRewriteCheckpoint({
                    content,
                    prompt,
                    fileName,
                    blocks,
                    model: config.model,
                    blockInputTokens: config.processing.blockInputTokens,
                    generationSignature: {
                        temperature: config.generationConfig.temperature,
                        maxOutputRatio: config.outputPolicy.maxOutputRatio,
                        outputMultiplier: config.outputPolicy.maxOutputTokenMultiplier,
                        maxOutputTokensPerRequest: config.outputPolicy.maxOutputTokensPerRequest,
                        visualPlanHash: options.visualPlanHash || null,
                        visualTopicSlugs: Array.isArray(options.visualTopicSlugs)
                            ? [...options.visualTopicSlugs].sort()
                            : [],
                    },
                })
                : null;

            console.log(`📄 Processando ${blocks.length} blocos para o arquivo: ${fileName}`);
            if (checkpoint?.count()) {
                console.log(`  ♻️ Checkpoint encontrado: ${checkpoint.count()} bloco(s) concluído(s) serão reutilizados.`);
            }

            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                const blockNumber = i + 1;
                const workUnitId = `b${String(blockNumber).padStart(3, '0')}`;
                const blockPrompt = getBlockPrompt(prompt, blockNumber, blocks.length);
                const cachedBlock = checkpoint?.get(blockNumber);
                if (cachedBlock) {
                    rewrittenBlocks.push(cachedBlock);
                    processedBlocks++;
                    console.log(`  ♻️ Bloco ${blockNumber}/${blocks.length} restaurado do checkpoint.`);
                    continue;
                }

                const budget = createRequestBudget(
                    `bloco ${blockNumber}/${blocks.length}`,
                    config.retry.maxApiCallsPerRootBlock,
                    fileBudget
                );
                global.performanceLogger?.logBlockStart(
                    blockNumber,
                    blocks.length,
                    estimateTokens(block),
                    { workUnitId }
                );

                try {
                    console.log(`  🔄 Bloco ${blockNumber}/${blocks.length} (~${estimateTokens(block)} tokens)`);
                    const rewrittenBlock = await rewriteBlockWithRecovery(
                        block,
                        blockPrompt,
                        `bloco ${blockNumber}/${blocks.length}`,
                        {
                            budget,
                            workUnitId,
                            basePrompt: blockPrompt,
                        }
                    );
                    rewrittenBlocks.push(rewrittenBlock);
                    processedBlocks++;
                    checkpoint?.save(blockNumber, rewrittenBlock);
                    global.performanceLogger?.logBlockEnd(
                        workUnitId,
                        true,
                        null,
                        rewrittenBlock.length,
                        { apiCallsUsed: budget.used }
                    );
                    console.log(`  ✅ Bloco ${blockNumber} processado em ${budget.used} chamada(s) (${rewrittenBlock.length} caracteres)`);
                } catch (blockError) {
                    blockErrors++;
                    processedBlocks++;
                    apiStats.preservedBlocks++;
                    global.performanceLogger?.recordGenerationEvent('preservedBlocks');
                    rewrittenBlocks.push(block.trim());
                    failedBlockDetails.push({
                        blockNumber,
                        totalBlocks: blocks.length,
                        workUnitId,
                        apiCallsUsed: budget.used,
                        error: blockError.message,
                    });
                    global.performanceLogger?.logBlockEnd(
                        workUnitId,
                        false,
                        blockError.message,
                        0,
                        { apiCallsUsed: budget.used, preservedOriginal: true }
                    );
                    logger.error(`Erro definitivo e limitado no bloco ${blockNumber}: ${blockError.message}`);
                    console.log(`  📝 Bloco ${blockNumber} preservado sem reescrita após ${budget.used} chamada(s).`);
                }

                if (i < blocks.length - 1) {
                    const delayMs = config.getAdaptiveDelay
                        ? config.getAdaptiveDelay(estimateTokens(block), 'betweenBlocks')
                        : config.delays.betweenBlocks;
                    const delaySeconds = Math.max(0, Math.round(delayMs / 1000));
                    console.log(`  ⏳ Aguardando ${delaySeconds}s antes do próximo bloco...`);
                    global.performanceLogger?.recordDelay(delayMs, 'betweenBlocks');
                    await sleep(delaySeconds);
                }
            }

            const finalContent = rewrittenBlocks.join('\n\n');

            console.log(`\n📊 Resumo do processamento para ${fileName}:`);
            console.log(`   ✅ Blocos processados: ${processedBlocks}/${blocks.length}`);
            console.log(`   📝 Blocos preservados sem reescrita: ${blockErrors}`);
            console.log(`   ☁️ Chamadas usadas: ${fileBudget.used}/${fileBudget.maximum}`);

            logger.info(`Processamento em blocos concluído para ${fileName}: ${processedBlocks}/${blocks.length} blocos, ${blockErrors} erros`);

            assertSourceHeadingCoverage(content, finalContent);

            const visualReadyContent = options.visualTopics?.length > 0
                ? appendRequiredVisualFallback(
                    trimExcessVisualResources(finalContent, options.visualTopics),
                    options.visualTopics
                )
                : finalContent;
            if (options.visualTopics?.length > 0) {
                const compliance = validateVisualCompliance(visualReadyContent, {
                    visualTopics: options.visualTopics,
                });
                if (!compliance.valid) {
                    const error = new Error(
                        `Conformidade visual inválida: ${compliance.issues.map(issue => issue.message).join(' ')}`
                    );
                    error.code = 'PYGEM_VISUAL_COMPLIANCE_INVALID';
                    error.details = compliance;
                    throw error;
                }
            }

            if (failedBlockDetails.length > 0) {
                logger.warn(`Blocos preservados sem reescrita: ${failedBlockDetails.map(detail => `#${detail.blockNumber}`).join(', ')}`);
                logger.warn(`Checkpoint mantido para retomar somente os blocos pendentes: ${checkpoint?.filePath || 'desabilitado'}`);
                throw createPartialRewriteError(failedBlockDetails, blocks.length);
            } else {
                checkpoint?.clear();
            }

            return visualReadyContent;

        } catch (error) {
            logger.error(`Erro geral no processamento em blocos: ${error.message}`);
            throw error;
        }
    },

    async testConnection(retryCount = 0) {
        const maxRetries = 2;
        
        try {
            if (!config.hasValidVertexConfig()) {
                return {
                    success: false,
                    error: 'Configuração do Vertex AI incompleta. Defina GOOGLE_CLOUD_PROJECT e GOOGLE_CLOUD_LOCATION no arquivo .env.',
                    model: 'N/A'
                };
            }

            const currentModel = config.model;
            
            console.log(`☁️ Projeto Vertex AI: ${config.project} (${config.location})`);
            console.log(`🤖 Modelo: ${currentModel}`);
            
            const model = getGenerativeModel({ 
                model: currentModel,
                generationConfig: buildGenerationConfig({
                    temperature: 0.1,
                    maxOutputTokens: 100
                }),
                safetySettings: config.safetySettings,
            });

            const result = await model.generateContent('Teste de conexão');
            const response = await result.response;
            const text = response.text();

            return {
                success: true,
                message: `Conexão estabelecida com sucesso`,
                model: currentModel
            };

        } catch (error) {
            let errorMessage = error.message;
            
            // Tratamento específico para diferentes tipos de erro
            if (isUnavailableError(error)) {
                errorMessage = 'Serviço temporariamente indisponível. O modelo Gemini está sobrecarregado. Tente novamente em alguns minutos.';
            } else if (isQuotaError(error)) {
                errorMessage = 'Limite de cota do Vertex AI excedido. Verifique as cotas do projeto no Google Cloud Console.';
            } else if (isAuthenticationError(error)) {
                errorMessage = 'Falha na autenticação ADC. Execute "gcloud auth application-default login".';
            } else if (isPermissionError(error)) {
                errorMessage = 'Acesso negado. Verifique a API Vertex AI e o papel Vertex AI User da identidade autenticada.';
            }
            
            if (retryCount < maxRetries && (isQuotaError(error) || isUnavailableError(error))) {
                await sleep(config.delays.onQuotaError / 1000);
                return await this.testConnection(retryCount + 1);
            }
            
            return {
                success: false,
                error: errorMessage,
                model: 'N/A'
            };
        }
    },

    /**
     * Enriquece conteúdo com gráficos Mermaid (conteúdo completo)
     * @param {string} content - Conteúdo a ser enriquecido
     * @param {string} prompt - Prompt de instruções
     * @param {number} retryCount - Contador de tentativas (interno)
     * @returns {string} - Conteúdo enriquecido com gráficos Mermaid
     */
    async enhanceContentWithMermaid(content, prompt, retryCount = 0) {
        const maxRetries = 3;

        try {
            if (!config.hasValidVertexConfig()) {
                throw new Error('Configuração do Vertex AI incompleta. Verifique o arquivo .env.');
            }

            apiStats.requests++;
            logger.info(`Iniciando enriquecimento Mermaid com Vertex AI (tentativa ${retryCount + 1}/${maxRetries + 1})`);

            // Configura o modelo com temperatura baixa para precisão
            const mermaidGenerationConfig = {
                ...config.generationConfig,
                temperature: 0.2, // Temperatura ainda mais baixa para evitar modificações indesejadas
            };

            const currentModel = config.model;
            console.log(`Usando modelo Vertex AI: ${currentModel} para enriquecimento Mermaid`);

            const model = getGenerativeModel({
                model: currentModel,
                generationConfig: mermaidGenerationConfig,
                safetySettings: config.safetySettings
            });

            // Combina o prompt com o conteúdo
            const fullPrompt = `${prompt}\n\n${content}`;

            // Faz a chamada para a API
            const result = await model.generateContent(fullPrompt);
            const response = await result.response;
            const enrichedContent = response.text();

            logger.info(`Conteúdo enriquecido com gráficos Mermaid com sucesso (${enrichedContent.length} caracteres)`);
            return enrichedContent;

        } catch (error) {
            apiStats.apiErrors++;
            logger.error(`Erro ao enriquecer conteúdo com Mermaid (Tentativa ${retryCount + 1}): ${error.message}`);

            if (isAuthenticationError(error)) {
                throw new Error('Falha na autenticação ADC. Execute "gcloud auth application-default login".');
            } else if (isPermissionError(error)) {
                throw new Error('Acesso negado pelo Vertex AI. Verifique a API e as permissões IAM do projeto.');
            } else if (isQuotaError(error)) {
                if (retryCount < maxRetries) {
                    logger.info('Cota do Vertex AI excedida para Mermaid; aguardando nova tentativa.');
                    console.log('⚠️ Cota do Vertex AI excedida para Mermaid; tentando novamente...');
                    await sleep(config.delays.onQuotaError / 1000);
                    return await this.enhanceContentWithMermaid(content, prompt, retryCount + 1);
                }

                throw new Error('Cota do Vertex AI excedida para enriquecimento Mermaid. Verifique as cotas do projeto.');
            } else if (isUnavailableError(error)) {
                console.log('⚠️ MODELO SOBRECARREGADO PARA MERMAID - Tentando alternativas...');

                if (retryCount < maxRetries) {
                    logger.info('Tentando com modelo fallback devido à sobrecarga para Mermaid...');
                    const simpleModel = config.fallbackModel;
                    console.log(`🔄 Tentando com modelo ${simpleModel} para Mermaid...`);

                    try {
                        const model = getGenerativeModel({
                            model: simpleModel,
                            generationConfig: config.generationConfig,
                            safetySettings: config.safetySettings
                        });

                        const fullPrompt = `${prompt}\n\n${content}`;
                        const result = await model.generateContent(fullPrompt);
                        const response = await result.response;
                        const enrichedContent = response.text();

                        logger.info(`Conteúdo enriquecido com Mermaid usando modelo fallback (${enrichedContent.length} caracteres)`);
                        return enrichedContent;

                    } catch (fallbackError) {
                        logger.error(`Erro no fallback: ${fallbackError.message}`);
                    }
                }
            }

            throw error;
        }
    },

    /**
     * Enriquece conteúdo com gráficos Mermaid em blocos
     * @param {Array<string>} blocks - Array de blocos de conteúdo
     * @param {string} prompt - Prompt de instruções
     * @returns {string} - Conteúdo completo enriquecido com gráficos Mermaid
     */
    async enhanceContentWithMermaidInBlocks(blocks, prompt) {
        // Configura o modelo com temperatura baixa
        const mermaidGenerationConfig = {
            ...config.generationConfig,
            temperature: 0.2, // Temperatura baixa para evitar modificações indesejadas
        };

        const currentModel = config.model;
        const model = getGenerativeModel({
            model: currentModel,
            generationConfig: mermaidGenerationConfig,
            safetySettings: config.safetySettings
        });

        let finalContent = '';
        let processedBlocks = 0;
        let errorCount = 0;

        console.log(`📄 Processando ${blocks.length} blocos para enriquecimento Mermaid`);

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const blockNumber = i + 1;
            let blockProcessed = false;
            let retryCount = 0;
            const maxBlockRetries = 3;

            while (!blockProcessed && retryCount <= maxBlockRetries) {
                try {
                    apiStats.requests++;

                    // Prompt para enriquecimento Mermaid
                    const fullPrompt = `${prompt}\n\n${block}`;

                    // Faz a chamada para a API
                    const result = await model.generateContent(fullPrompt);
                    const response = await result.response;
                    const enrichedBlock = response.text();

                    // Adiciona o conteúdo enriquecido ao resultado final
                    finalContent += enrichedBlock;

                    // Adiciona quebra de linha entre blocos se necessário
                    if (i < blocks.length - 1) {
                        finalContent += '\n\n';
                    }

                    processedBlocks++;
                    blockProcessed = true;

                    console.log(`  ✅ Bloco ${blockNumber} enriquecido com Mermaid (${enrichedBlock.length} caracteres)`);
                    logger.info(`Bloco ${blockNumber} enriquecido com Mermaid - ${enrichedBlock.length} caracteres`);

                    // Aguarda entre blocos (exceto no último)
                    if (i < blocks.length - 1) {
                        const delayMs = config.getAdaptiveDelay
                            ? config.getAdaptiveDelay(estimateTokens(block), 'betweenBlocks')
                            : config.delays.betweenBlocks;

                        const delaySeconds = Math.max(0, Math.round(delayMs / 1000));
                        console.log(`  ⏳ Aguardando ${delaySeconds} segundos antes do próximo bloco Mermaid...`);
                        global.performanceLogger?.recordDelay(delayMs, 'betweenBlocks');
                        await sleep(delaySeconds);
                    }

                } catch (blockError) {
                    errorCount++;
                    apiStats.apiErrors++;
                    retryCount++;
                    logger.error(`Erro ao enriquecer bloco ${blockNumber} com Mermaid (Tentativa ${retryCount}): ${blockError.message}`);

                    if (isQuotaError(blockError) && retryCount <= maxBlockRetries) {
                        console.log(`  🔄 Erro de cota no bloco ${blockNumber} Mermaid; tentando novamente...`);
                        logger.info(`Aguardando nova tentativa do bloco ${blockNumber} Mermaid devido à cota do Vertex AI`);
                        global.performanceLogger?.recordDelay(config.delays.onQuotaError, 'quota');
                        await sleep(config.delays.onQuotaError / 1000);
                        continue;
                    }

                    // Verifica se é um erro de RECITATION e tenta novamente com temperatura um pouco mais alta
                    if (blockError.message.includes('RECITATION') && retryCount <= maxBlockRetries) {
                        console.log(`  ⚠️ Erro de RECITATION detectado no bloco ${blockNumber} Mermaid. Tentando novamente...`);
                        logger.info(`Tentando novamente o bloco ${blockNumber} Mermaid com temperatura ajustada`);

                        try {
                            // Aumenta ligeiramente a temperatura, mas mantém baixa
                            const retryModel = getGenerativeModel({
                                model: config.model,
                                generationConfig: {
                                    ...config.generationConfig,
                                    temperature: 0.4, // Temperatura um pouco mais alta para evitar RECITATION
                                },
                                safetySettings: config.safetySettings
                            });

                            const fullPrompt = `${prompt}\n\n${block}`;
                            const result = await retryModel.generateContent(fullPrompt);
                            const response = await result.response;
                            const enrichedBlock = response.text();

                            finalContent += enrichedBlock;
                            if (i < blocks.length - 1) {
                                finalContent += '\n\n';
                            }

                            processedBlocks++;
                            blockProcessed = true;

                            console.log(`  ✅ Bloco ${blockNumber} Mermaid processado com temperatura ajustada`);
                            logger.info(`Bloco ${blockNumber} Mermaid processado com temperatura ajustada`);

                        } catch (retryError) {
                            logger.error(`Erro na tentativa com temperatura ajustada: ${retryError.message}`);
                        }
                    }

                    // Se chegou aqui, o bloco falhou definitivamente
                    if (!blockProcessed) {
                        console.log(`  ❌ Bloco ${blockNumber} Mermaid falhou definitivamente após ${retryCount} tentativas`);
                        logger.error(`Bloco ${blockNumber} Mermaid falhou definitivamente`);

                        // Adiciona o bloco original sem modificações se falhar
                        finalContent += block;
                        if (i < blocks.length - 1) {
                            finalContent += '\n\n';
                        }
                        processedBlocks++;
                        blockProcessed = true;
                    }
                }
            }
        }

        console.log(`📊 Enriquecimento Mermaid concluído: ${processedBlocks} blocos processados, ${errorCount} erros`);
        logger.info(`Enriquecimento Mermaid concluído: ${processedBlocks} blocos, ${errorCount} erros`);

        return finalContent;
    },

    // Expor utilitários de diagnóstico
    getApiStats,
    refreshGeminiClient,
    diagnostics: {
        GENERATION_FAILURE,
        buildGenerationConfig,
        calculateMaxOutputTokens,
        calculateRequestRetryDelayMs,
        isTransientCapacityError,
        isRequestTimeoutError,
        isSuccessfulFinishReason,
        getRetryInstruction,
        getContentScaleInstruction,
        buildAttemptPrompt,
        replaceLineBreakTagsOutsideMermaid,
        shouldRewriteInBlocks,
        getRecoverySubdivision,
        createRequestBudget,
        createPartialRewriteError,
        generateValidatedRewrite,
        rewriteBlockWithRecovery,
        shouldPreserveShortSourceAfterThinkingLeak,
    },
    shouldRewriteInBlocks,
};

module.exports = geminiService;
