const { GoogleGenAI } = require('@google/genai');
const config = require('../config/runtime');
const logger = require('../utils/logger');
const { splitContentIntoBlocks, estimateTokens, sleep } = require('./tokenService');
const {
    sanitizeModelOutput,
    isThinkingLeak,
    isOutputTooShort,
    isOutputTooLong,
    extractFinishReason,
    getBlockPrompt,
} = require('../utils/contentPreprocessor');
const {
    validateGeneratedContent,
    validateSourceHeadingCoverage,
    assertSourceHeadingCoverage,
} = require('../utils/validation');
let genAI = null;
const apiStats = {
    requests: 0,
    apiErrors: 0,
    validationFailures: 0,
    truncatedResponses: 0,
    retries: 0,
    continuations: 0,
};

const GENERATION_FAILURE = Object.freeze({
    EMPTY: 'empty',
    MAX_TOKENS: 'max_tokens',
    TOO_SHORT: 'too_short',
    TOO_LONG: 'too_long',
    THINKING_LEAK: 'thinking_leak',
    INVALID_STRUCTURE: 'invalid_structure',
});

/**
 * Reinicializa o cliente da API do Gemini para evitar conflitos entre documentos
 */
const refreshGeminiClient = () => {
    if (!config.hasValidVertexConfig()) {
        genAI = null;
        return false;
    }

    genAI = new GoogleGenAI({
        vertexai: true,
        project: config.project,
        location: config.location,
        apiVersion: config.apiVersion,
    });
    logger.info(`Cliente Vertex AI inicializado (projeto: ${config.project}, região: ${config.location})`);
    return true;
};

const getGeminiClient = () => {
    if (!genAI && !refreshGeminiClient()) {
        throw new Error('Configuração do Vertex AI incompleta. Verifique GOOGLE_CLOUD_PROJECT e GOOGLE_CLOUD_LOCATION.');
    }
    return genAI;
};

// Adapta o SDK atual à pequena interface de modelo usada pela aplicação.
const getGenerativeModel = ({ model, generationConfig, safetySettings }) => ({
    async generateContent(contents) {
        const response = await getGeminiClient().models.generateContent({
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

function buildGenerationConfig(overrides = {}) {
    return {
        ...config.generationConfig,
        ...overrides,
    };
}

function createModel(overrides = {}, modelName = config.model) {
    return {
        model: getGenerativeModel({
            model: modelName,
            generationConfig: buildGenerationConfig(overrides),
            safetySettings: config.safetySettings,
        }),
        modelName,
    };
}

async function generateRewriteOnce(model, modelName, fullPrompt, context = {}) {
    apiStats.requests++;
    const startedAt = Date.now();
    const inputTokens = estimateTokens(fullPrompt);

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
            continuation: context.continuation || 0,
        });
        throw error;
    }
}

function calculateMaxOutputTokens(content, maxRatio = config.outputPolicy.maxOutputRatio) {
    const proportionalBudget = Math.ceil(
        estimateTokens(content) * maxRatio * config.outputPolicy.maxOutputTokenMultiplier
    );

    return Math.min(
        config.generationConfig.maxOutputTokens,
        Math.max(config.outputPolicy.minOutputTokens, proportionalBudget)
    );
}

function getRetryInstruction(failure) {
    switch (failure?.reason) {
        case GENERATION_FAILURE.MAX_TOKENS:
            return 'A tentativa anterior foi truncada. Produza uma versão completa e concisa em uma única resposta, sem planejamento ou raciocínio interno.';
        case GENERATION_FAILURE.TOO_SHORT:
        case GENERATION_FAILURE.EMPTY:
            return 'A tentativa anterior omitiu conteúdo. Preserve todos os conceitos, valores, exemplos e exceções presentes no texto fornecido.';
        case GENERATION_FAILURE.TOO_LONG:
            return 'A tentativa anterior expandiu excessivamente o material. Não acrescente conteúdo externo, não repita informações e use recursos didáticos apenas quando indispensáveis.';
        case GENERATION_FAILURE.THINKING_LEAK:
            return 'Entregue exclusivamente o Markdown final, sem planejamento, análise interna ou comentários sobre o processo de reescrita.';
        case GENERATION_FAILURE.INVALID_STRUCTURE:
            return `A tentativa anterior apresentou estrutura Markdown inválida. Corrija especificamente: ${failure.details}`;
        default:
            return '';
    }
}

function buildAttemptPrompt(prompt, content, lastFailure) {
    const retryInstruction = getRetryInstruction(lastFailure);
    return [
        prompt,
        retryInstruction ? `## CORREÇÃO DA NOVA TENTATIVA\n${retryInstruction}` : '',
        content,
    ].filter(Boolean).join('\n\n');
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
    ]);
    const blockTokens = estimateTokens(block);

    if (
        error?.code !== 'PYGEM_OUTPUT_INVALID'
        || !recoverableReasons.has(error?.details?.reason)
        || depth >= config.processing.maxBlockSubdivisionDepth
        || blockTokens <= config.processing.minRecoveryBlockTokens
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
    const allowContinuation = options.allowContinuation === true
        && estimateTokens(content) >= config.retry.continuationMinInputTokens;
    const maxContinuationCount = allowContinuation ? config.retry.maxContinuationCount : 0;
    const maxOutputTokens = calculateMaxOutputTokens(content, maxRatio);
    let lastFailure = null;
    let fallbackActivated = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1 && [
            GENERATION_FAILURE.MAX_TOKENS,
            GENERATION_FAILURE.TOO_LONG,
        ].includes(lastFailure?.reason)) {
            fallbackActivated = true;
        }
        const modelName = fallbackActivated
            ? config.fallbackModel
            : config.model;
        const { model } = createModel({
            maxOutputTokens,
            ...(attempt > 1 ? { temperature: 0.2 } : {}),
        }, modelName);

        let accumulated = '';
        let continuationCount = 0;
        let promptToSend = buildAttemptPrompt(prompt, content, lastFailure);
        let lastUsageMetadata = {};

        while (continuationCount <= maxContinuationCount) {
            console.log(`Usando modelo: ${modelName} (${label}, tentativa ${attempt}${continuationCount ? `, continuação ${continuationCount}` : ''})`);

            const result = await generateRewriteOnce(model, modelName, promptToSend, {
                attempt,
                continuation: continuationCount,
            });
            const { text, finishReason, usageMetadata } = result;
            lastUsageMetadata = usageMetadata;
            accumulated = accumulated ? `${accumulated}\n\n${text}` : text;

            if (isOutputTooLong(content, accumulated, maxRatio)) {
                lastFailure = {
                    reason: GENERATION_FAILURE.TOO_LONG,
                    attempt,
                    finishReason,
                    originalLength: content.length,
                    outputLength: accumulated.length,
                    usageMetadata: lastUsageMetadata,
                };
                console.log(`  ⚠️ Saída excessiva em ${label}; descartando a tentativa integral.`);
                break;
            }

            if (finishReason === 'MAX_TOKENS') {
                apiStats.truncatedResponses++;
                global.performanceLogger?.recordGenerationEvent('truncatedResponses');

                if (allowContinuation && continuationCount < maxContinuationCount) {
                    continuationCount++;
                    apiStats.continuations++;
                    global.performanceLogger?.recordGenerationEvent('continuations');
                    console.log('  ⚠️ Resposta truncada; solicitando continuação controlada...');
                    promptToSend = `${prompt}\n\nContinue a reescrita sem repetir trechos. Entregue somente o Markdown restante.\n\n--- FINAL JÁ REESCRITO ---\n${accumulated.slice(-2500)}\n\n--- CONTEÚDO ORIGINAL ---\n${content}`;
                    continue;
                }

                lastFailure = {
                    reason: GENERATION_FAILURE.MAX_TOKENS,
                    attempt,
                    finishReason,
                    originalLength: content.length,
                    outputLength: accumulated.length,
                    usageMetadata: lastUsageMetadata,
                };
                console.log(`  ⚠️ Resposta truncada em ${label}; descartando a tentativa integral.`);
                break;
            }
            break;
        }

        if (lastFailure?.attempt === attempt && lastFailure.reason === GENERATION_FAILURE.MAX_TOKENS) {
            await waitForValidationRetry(attempt, maxAttempts, 1);
            continue;
        }

        if (!accumulated.trim()) {
            lastFailure = {
                reason: GENERATION_FAILURE.EMPTY,
                attempt,
                originalLength: content.length,
                outputLength: 0,
                usageMetadata: lastUsageMetadata,
            };
        } else if (isThinkingLeak(accumulated)) {
            lastFailure = {
                reason: GENERATION_FAILURE.THINKING_LEAK,
                attempt,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata: lastUsageMetadata,
            };
        } else if (isOutputTooShort(content, accumulated, minRatio)) {
            lastFailure = {
                reason: GENERATION_FAILURE.TOO_SHORT,
                attempt,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata: lastUsageMetadata,
            };
        } else if (isOutputTooLong(content, accumulated, maxRatio)) {
            lastFailure = {
                reason: GENERATION_FAILURE.TOO_LONG,
                attempt,
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata: lastUsageMetadata,
            };
        } else {
            const outputValidation = validateGeneratedContent(accumulated);
            const headingCoverage = validateSourceHeadingCoverage(content, accumulated);
            if (outputValidation.valid && headingCoverage.valid) {
                logger.info(`${label} reescrito com sucesso (${accumulated.length} caracteres)`);
                return accumulated;
            }

            lastFailure = {
                reason: GENERATION_FAILURE.INVALID_STRUCTURE,
                attempt,
                details: [...outputValidation.issues, ...headingCoverage.issues].join(' '),
                originalLength: content.length,
                outputLength: accumulated.length,
                usageMetadata: lastUsageMetadata,
            };
        }

        apiStats.validationFailures++;
        global.performanceLogger?.recordGenerationEvent('validationFailures');
        logger.warn(`Saída rejeitada em ${label}: ${lastFailure.reason}${lastFailure.details ? ` - ${lastFailure.details}` : ''}`);
        console.log(`  ⚠️ Saída rejeitada (${lastFailure.reason}), retentando (${attempt}/${maxAttempts})...`);
        await waitForValidationRetry(attempt, maxAttempts, lastFailure.reason === GENERATION_FAILURE.TOO_SHORT ? 3 : 1);
    }

    const finalReason = lastFailure?.reason || 'desconhecido';
    const error = new Error(
        `Falha ao reescrever ${label} após ${maxAttempts} tentativas. `
        + `Última rejeição: ${finalReason}; saída ${lastFailure?.outputLength ?? 0}/${lastFailure?.originalLength ?? content.length} caracteres.`
    );
    error.code = 'PYGEM_OUTPUT_INVALID';
    error.details = lastFailure;
    throw error;
}

async function rewriteBlockWithRecovery(block, prompt, label, depth = 0) {
    try {
        return await generateValidatedRewrite(block, prompt, {
            label,
            minOutputRatio: 0.7,
        });
    } catch (error) {
        const fragments = getRecoverySubdivision(block, error, depth);
        if (!fragments) throw error;

        logger.warn(
            `${label} será subdividido em ${fragments.length} fragmentos após ${error.details.reason}.`
        );
        console.log(
            `  ↪️ ${label} truncado; recuperando em ${fragments.length} fragmentos menores...`
        );

        const rewrittenFragments = [];
        for (let index = 0; index < fragments.length; index++) {
            const fragmentLabel = `${label}, fragmento ${index + 1}/${fragments.length}`;
            const fragmentPrompt = [
                prompt,
                '## RECUPERAÇÃO DE BLOCO',
                `Reescreva somente o fragmento ${index + 1} de ${fragments.length} abaixo. `
                    + 'Não antecipe nem repita os demais fragmentos.',
            ].join('\n\n');
            rewrittenFragments.push(
                await rewriteBlockWithRecovery(
                    fragments[index],
                    fragmentPrompt,
                    fragmentLabel,
                    depth + 1
                )
            );
        }

        return rewrittenFragments.join('\n\n');
    }
}

const errorMatches = (error, pattern) => pattern.test(`${error?.status || ''} ${error?.message || ''}`);
const isAuthenticationError = (error) => errorMatches(error, /401|UNAUTHENTICATED|default credentials|invalid_grant/i);
const isPermissionError = (error) => errorMatches(error, /403|PERMISSION_DENIED/i);
const isQuotaError = (error) => errorMatches(error, /429|RESOURCE_EXHAUSTED|quota|Too Many Requests/i);
const isUnavailableError = (error) => errorMatches(error, /503|UNAVAILABLE|Service Unavailable|overloaded/i);

const geminiService = {
    async rewriteContent(content, prompt, retryCount = 0) {
        const maxRetries = config.retry.maxFileRetries;

        try {
            if (!config.hasValidVertexConfig()) {
                throw new Error('Configuração do Vertex AI incompleta. Verifique o arquivo .env.');
            }

            logger.info(`Iniciando chamada ao Vertex AI (tentativa ${retryCount + 1}/${maxRetries + 1})`);

            return await generateValidatedRewrite(content, prompt, { label: 'conteúdo' });

        } catch (error) {
            logger.error(`Falha no fluxo de reescrita (tentativa de arquivo ${retryCount + 1}): ${error.message}`);
            
            // Tratamento de erros específicos do Vertex AI.
            if (isAuthenticationError(error)) {
                throw new Error('Falha na autenticação ADC. Execute "gcloud auth application-default login" ou configure uma identidade de serviço segura.');
            } else if (isPermissionError(error)) {
                throw new Error('Acesso negado pelo Vertex AI. Verifique a API Vertex AI e o papel Vertex AI User.');
            } else if (isQuotaError(error)) {
                if (retryCount < maxRetries) {
                    logger.info('Cota/limite temporário do Vertex AI atingido; aguardando antes de tentar novamente.');
                    console.log('⚠️ Limite temporário do Vertex AI atingido; tentando novamente...');
                    global.performanceLogger?.recordDelay(config.delays.onQuotaError, 'quota');
                    await sleep(config.delays.onQuotaError / 1000);
                    return await this.rewriteContent(content, prompt, retryCount + 1);
                }
                
                throw new Error('Cota ou limite do Vertex AI excedido. Verifique as cotas do projeto no Google Cloud Console.');
            } else if (isUnavailableError(error)) {
                // Modelo sobrecarregado: tenta o modelo fallback no mesmo projeto Vertex AI.
                console.log('⚠️ MODELO SOBRECARREGADO - Tentando alternativas...');

                if (retryCount < maxRetries) {
                    logger.info('Tentando com modelo fallback devido à sobrecarga...');
                    const simpleModel = config.fallbackModel;
                    console.log(`🔄 Tentando com modelo ${simpleModel}...`);

                    try {
                        const model = getGenerativeModel({
                            model: simpleModel,
                            generationConfig: config.generationConfig,
                            safetySettings: config.safetySettings
                        });

                        const fallbackResult = await generateRewriteOnce(
                            model,
                            simpleModel,
                            `${prompt}\n\n${content}`,
                            { attempt: retryCount + 1 }
                        );
                        const fallbackContent = fallbackResult.text;

                        if (fallbackResult.finishReason === 'MAX_TOKENS') {
                            apiStats.truncatedResponses++;
                            global.performanceLogger?.recordGenerationEvent('truncatedResponses');
                            throw new Error('Resposta do modelo fallback truncada por MAX_TOKENS.');
                        }

                        if (isOutputTooLong(content, fallbackContent, config.outputPolicy.maxOutputRatio)) {
                            throw new Error('Resposta do modelo fallback excedeu o limite proporcional de saída.');
                        }
                        const fallbackValidation = validateGeneratedContent(fallbackContent);
                        if (!fallbackValidation.valid) {
                            apiStats.validationFailures++;
                            global.performanceLogger?.recordGenerationEvent('validationFailures');
                            throw new Error(`Resposta do modelo fallback inválida: ${fallbackValidation.issues.join(' ')}`);
                        }

                        console.log(`✅ Sucesso com modelo fallback: ${simpleModel}`);
                        logger.info(`Conteúdo gerado com modelo fallback (${fallbackContent.length} caracteres)`);
                        return fallbackContent;
                    } catch (fallbackError) {
                        logger.error(`Erro no modelo fallback: ${fallbackError.message}`);
                        global.performanceLogger?.recordDelay(config.delays.onError, 'error');
                        await sleep(config.delays.onError / 1000);
                        return await this.rewriteContent(content, prompt, retryCount + 1);
                    }
                }

                throw new Error('Modelo do Vertex AI temporariamente indisponível. Aguarde alguns minutos ou configure GEMINI_FALLBACK_MODEL.');
            } else if (errorMatches(error, /safety|SAFETY/i)) {
                throw new Error('Conteúdo bloqueado pelas configurações de segurança');
            } else if (error.code === 'PYGEM_OUTPUT_INVALID') {
                throw error;
            } else if (retryCount < maxRetries) {
                // Retry genérico para outros erros
                logger.info(`Tentando novamente em ${config.delays.onError / 1000} segundos...`);
                global.performanceLogger?.recordDelay(config.delays.onError, 'error');
                await sleep(config.delays.onError / 1000);
                return await this.rewriteContent(content, prompt, retryCount + 1);
            } else {
                throw new Error(`Falha ao reescrever o conteúdo após ${maxRetries + 1} tentativas: ${error.message}`);
            }
        }
    },

    async rewriteContentInBlocks(content, prompt, fileName) {
        try {
            if (!config.hasValidVertexConfig()) {
                throw new Error('Configuração do Vertex AI incompleta. Verifique o arquivo .env.');
            }

            logger.info(`Iniciando processamento em blocos no Vertex AI para arquivo: ${fileName}`);

            const blocks = splitContentIntoBlocks(content, config.processing.blockInputTokens);
            let finalContent = '';
            let processedBlocks = 0;
            let blockErrors = 0;

            console.log(`📄 Processando ${blocks.length} blocos para o arquivo: ${fileName}`);

            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];
                const blockNumber = i + 1;
                const blockPrompt = getBlockPrompt(prompt, blockNumber, blocks.length);

                try {
                    console.log(`  🔄 Bloco ${blockNumber}/${blocks.length} (~${estimateTokens(block)} tokens)`);
                    global.performanceLogger?.logBlockStart(
                        blockNumber,
                        blocks.length,
                        estimateTokens(block)
                    );

                    const rewrittenBlock = await rewriteBlockWithRecovery(
                        block,
                        blockPrompt,
                        `bloco ${blockNumber}/${blocks.length}`
                    );

                    if (finalContent) finalContent += '\n\n';
                    finalContent += rewrittenBlock;
                    processedBlocks++;

                    console.log(`  ✅ Bloco ${blockNumber} processado (${rewrittenBlock.length} caracteres)`);
                    logger.info(`Bloco ${blockNumber} processado - ${rewrittenBlock.length} caracteres`);

                    if (global.performanceLogger) {
                        global.performanceLogger.logBlockEnd(blockNumber, true, null, rewrittenBlock.length);
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
                } catch (blockError) {
                    blockErrors++;
                    logger.error(`Erro no bloco ${blockNumber}: ${blockError.message}`);
                    console.log(`  ❌ Erro no bloco ${blockNumber}: ${blockError.message}`);

                    if (global.performanceLogger) {
                        global.performanceLogger.logBlockEnd(blockNumber, false, blockError.message, 0);
                    }

                    const error = new Error(
                        `Falha definitiva no bloco ${blockNumber}/${blocks.length}; `
                        + `nenhum resultado parcial foi aceito. ${blockError.message}`
                    );
                    error.code = 'PYGEM_BLOCK_REWRITE_FAILED';
                    error.details = {
                        blockNumber,
                        totalBlocks: blocks.length,
                        cause: blockError.details || null,
                    };
                    throw error;
                }
            }

            console.log(`\n📊 Resumo do processamento para ${fileName}:`);
            console.log(`   ✅ Blocos processados: ${processedBlocks}/${blocks.length}`);
            console.log(`   ❌ Erros: ${blockErrors}`);

            logger.info(`Processamento em blocos concluído para ${fileName}: ${processedBlocks}/${blocks.length} blocos, ${blockErrors} erros`);

            assertSourceHeadingCoverage(content, finalContent);
            return finalContent;

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
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 100
                }
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
        calculateMaxOutputTokens,
        getRetryInstruction,
        buildAttemptPrompt,
        shouldRewriteInBlocks,
        getRecoverySubdivision,
    },
    shouldRewriteInBlocks,
};

module.exports = geminiService;
