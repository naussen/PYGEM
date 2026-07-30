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
const { validateGeneratedContent } = require('../utils/validation');
let genAI = null;
let requestCount = 0;
let errorCount = 0;

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
        requests: requestCount,
        errors: errorCount,
        authentication: 'ADC',
        project: config.project,
        location: config.location,
        model: config.model,
        successRate: requestCount > 0 ? ((requestCount - errorCount) / requestCount * 100).toFixed(2) + '%' : '0%'
    };
};

function buildGenerationConfig(overrides = {}) {
    return {
        ...config.generationConfig,
        ...overrides,
    };
}

function createModel(overrides = {}) {
    const currentModel = config.model;
    return {
        model: getGenerativeModel({
            model: currentModel,
            generationConfig: buildGenerationConfig(overrides),
            safetySettings: config.safetySettings,
        }),
        modelName: currentModel,
    };
}

async function generateRewriteOnce(model, fullPrompt) {
    requestCount++;
    const startedAt = Date.now();
    const inputTokens = estimateTokens(fullPrompt);

    try {
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const finishReason = extractFinishReason(response);
        const text = sanitizeModelOutput(response.text());
        const duration = Date.now() - startedAt;

        global.performanceLogger?.logApiCall(
            'models.generateContent',
            config.model,
            inputTokens,
            estimateTokens(text),
            duration,
            true
        );

        return { text, finishReason };
    } catch (error) {
        global.performanceLogger?.logApiCall(
            'models.generateContent',
            config.model,
            inputTokens,
            0,
            Date.now() - startedAt,
            false,
            error.message
        );
        throw error;
    }
}

async function generateValidatedRewrite(content, prompt, options = {}) {
    const maxAttempts = options.maxAttempts ?? config.retry.maxGenerationAttempts;
    const minRatio = options.minOutputRatio ?? 0.75;
    const maxRatio = options.maxOutputRatio ?? config.outputPolicy.maxOutputRatio;
    const label = options.label ?? 'conteúdo';
    const maxContinuationCount = config.retry.maxContinuationCount;
    const maxOutputTokens = Math.min(
        config.generationConfig.maxOutputTokens,
        Math.max(
            config.outputPolicy.minOutputTokens,
            Math.ceil(estimateTokens(content) * maxRatio * config.outputPolicy.maxOutputTokenMultiplier)
        )
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { model, modelName } = createModel({
            maxOutputTokens,
            ...(attempt > 1 ? { temperature: 0.2 } : {}),
        });

        let accumulated = '';
        let continuationCount = 0;
        let promptToSend = `${prompt}\n\n${content}`;

        while (continuationCount <= maxContinuationCount) {
            console.log(`Usando modelo: ${modelName} (${label}, tentativa ${attempt}${continuationCount ? `, continuação ${continuationCount + 1}` : ''})`);

            const { text, finishReason } = await generateRewriteOnce(model, promptToSend);
            accumulated = accumulated ? `${accumulated}\n\n${text}` : text;

            if (isOutputTooLong(content, accumulated, maxRatio)) {
                console.log(`  ⚠️ Saída excessiva em ${label}; descartando tentativa.`);
                logger.warn(`Saída excessiva em ${label}: ${accumulated.length}/${content.length} caracteres.`);
                break;
            }

            if (finishReason === 'MAX_TOKENS' && continuationCount < maxContinuationCount) {
                console.log('  ⚠️ Resposta truncada (MAX_TOKENS), solicitando continuação...');
                promptToSend = `${prompt}\n\nContinue a reescrita EXATAMENTE de onde parou. Não repita trechos já escritos. Entregue SOMENTE o markdown reescrito restante em português.\n\n--- JÁ REESCRITO (final) ---\n${accumulated.slice(-2500)}\n\n--- CONTEÚDO ORIGINAL COMPLETO (referência) ---\n${content}`;
                continuationCount++;
                continue;
            }
            break;
        }

        if (isThinkingLeak(accumulated)) {
            console.log(`  ⚠️ Raciocínio interno detectado, retentando (${attempt}/${maxAttempts})...`);
            logger.warn(`Raciocínio interno detectado em ${label}, retentativa ${attempt}`);
            global.performanceLogger?.recordDelay(3000, 'validation');
            await sleep(3);
            continue;
        }

        if (isOutputTooShort(content, accumulated, minRatio)) {
            console.log(`  ⚠️ Saída curta (${accumulated.length}/${content.length} chars), retentando (${attempt}/${maxAttempts})...`);
            logger.warn(`Saída insuficiente para ${label}: ${accumulated.length}/${content.length} chars`);
            global.performanceLogger?.recordDelay(3000, 'validation');
            await sleep(3);
            continue;
        }

        if (isOutputTooLong(content, accumulated, maxRatio)) {
            console.log(`  ⚠️ Saída excessiva (${accumulated.length}/${content.length} chars), retentando (${attempt}/${maxAttempts})...`);
            logger.warn(`Saída excessiva em ${label}: ${accumulated.length}/${content.length} caracteres`);
            global.performanceLogger?.recordDelay(1000, 'validation');
            await sleep(1);
            continue;
        }

        const outputValidation = validateGeneratedContent(accumulated);
        if (!outputValidation.valid) {
            const details = outputValidation.issues.join(' ');
            console.log(`  ⚠️ Estrutura inválida em ${label}; solicitando nova tentativa.`);
            logger.warn(`Estrutura inválida em ${label}: ${details}`);
            global.performanceLogger?.recordDelay(1000, 'validation');
            await sleep(1);
            continue;
        }

        logger.info(`${label} reescrito com sucesso (${accumulated.length} caracteres)`);
        return accumulated;
    }

    const error = new Error(`Falha ao reescrever ${label}: resposta inválida após ${maxAttempts} tentativas`);
    error.code = 'PYGEM_OUTPUT_INVALID';
    throw error;
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
            errorCount++;
            logger.error(`Erro ao comunicar com o Vertex AI (tentativa ${retryCount + 1}): ${error.message}`);
            
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

                        const result = await model.generateContent(`${prompt}\n\n${content}`);
                        const response = await result.response;
                        const fallbackContent = sanitizeModelOutput(response.text());

                        if (isOutputTooLong(content, fallbackContent, config.outputPolicy.maxOutputRatio)) {
                            throw new Error('Resposta do modelo fallback excedeu o limite proporcional de saída.');
                        }
                        const fallbackValidation = validateGeneratedContent(fallbackContent);
                        if (!fallbackValidation.valid) {
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

            const blocks = splitContentIntoBlocks(content);
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

                    const rewrittenBlock = await generateValidatedRewrite(block, blockPrompt, {
                        label: `bloco ${blockNumber}/${blocks.length}`,
                        minOutputRatio: 0.7,
                    });

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

                    if (finalContent) finalContent += '\n\n';
                    finalContent += `[ERRO: Não foi possível reescrever o bloco ${blockNumber}]\n\n${block}`;

                    if (global.performanceLogger) {
                        global.performanceLogger.logBlockEnd(blockNumber, false, blockError.message, 0);
                    }
                }
            }

            console.log(`\n📊 Resumo do processamento para ${fileName}:`);
            console.log(`   ✅ Blocos processados: ${processedBlocks}/${blocks.length}`);
            console.log(`   ❌ Erros: ${blockErrors}`);

            logger.info(`Processamento em blocos concluído para ${fileName}: ${processedBlocks}/${blocks.length} blocos, ${blockErrors} erros`);

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

            requestCount++;
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
            errorCount++;
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
                    requestCount++;

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
    refreshGeminiClient
};

module.exports = geminiService;
