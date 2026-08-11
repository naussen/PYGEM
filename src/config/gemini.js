require('dotenv').config();

const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global';
const supportedThinkingLevels = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
const requestedThinkingLevel = process.env.PYGEM_THINKING_LEVEL?.trim().toUpperCase();

function getModelCompatibilityIssues(modelName, modelLocation) {
    if (modelName === 'gemini-3.5-flash-lite' && !['global', 'us', 'eu'].includes(modelLocation)) {
        return [`${modelName} requer GOOGLE_CLOUD_LOCATION=global, us ou eu.`];
    }
    if (
        modelName === 'gemini-3.5-flash'
        && !['global', 'us', 'eu', 'europe-west2', 'asia-northeast1', 'asia-south1', 'asia-southeast1'].includes(modelLocation)
    ) {
        return [`${modelName} não está disponível em ${modelLocation}; use global, us, eu ou uma região oficialmente compatível.`];
    }
    return [];
}

function getPositiveNumberEnv(
    name,
    fallback,
    { integer = false, minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}
) {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fallback;
    return integer ? Math.floor(parsed) : parsed;
}

const config = {
    project,
    location,
    apiVersion: process.env.GOOGLE_GENAI_API_VERSION?.trim() || 'v1',
    // O fallback interno permanece 2.5 para não combinar silenciosamente um
    // .env legado em us-central1 com modelos 3.5, que não atendem essa região.
    // Novas instalações recebem o perfil 3.5 explícito pelo .env.example.
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-2.5-flash-lite',
    recoveryModel: process.env.GEMINI_RECOVERY_MODEL?.trim() || 'gemini-3.5-flash',
    recoveryLocation: process.env.GOOGLE_CLOUD_RECOVERY_LOCATION?.trim() || 'global',
    generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        topK: 20,
        maxOutputTokens: getPositiveNumberEnv(
            'PYGEM_MAX_OUTPUT_TOKENS',
            65536,
            { integer: true, minimum: 1, maximum: 65536 }
        ),
        candidateCount: 1,
        stopSequences: [],
        // Reescrita é uma tarefa transformacional. Um orçamento dinâmico de
        // thinking pode consumir o limite antes de o Markdown ser concluído.
        thinkingConfig: {
            thinkingBudget: getPositiveNumberEnv('PYGEM_THINKING_BUDGET', 0, { integer: true }),
            includeThoughts: false,
        },
        httpOptions: {
            timeout: getPositiveNumberEnv('PYGEM_REQUEST_TIMEOUT_MS', 120000, { integer: true, minimum: 10000 }),
        },
    },
    outputPolicy: {
        maxOutputRatio: getPositiveNumberEnv('PYGEM_MAX_OUTPUT_RATIO', 3, { minimum: 1 }),
        maxOutputTokenMultiplier: getPositiveNumberEnv('PYGEM_MAX_OUTPUT_TOKEN_MULTIPLIER', 1.1, { minimum: 1 }),
        minOutputTokens: getPositiveNumberEnv('PYGEM_MIN_OUTPUT_TOKENS', 1024, { integer: true, minimum: 256 }),
        maxOutputTokensPerRequest: getPositiveNumberEnv('PYGEM_MAX_OUTPUT_TOKENS_PER_REQUEST', 8192, { integer: true, minimum: 1024, maximum: 65536 }),
        fixedOutputReserveTokens: getPositiveNumberEnv('PYGEM_OUTPUT_RESERVE_TOKENS', 256, { integer: true, minimum: 0, maximum: 2048 }),
    },
    retry: {
        maxGenerationAttempts: getPositiveNumberEnv('PYGEM_MAX_GENERATION_ATTEMPTS', 2, { integer: true, minimum: 1, maximum: 2 }),
        maxRequestRetries: getPositiveNumberEnv('PYGEM_MAX_REQUEST_RETRIES', 1, { integer: true, maximum: 2 }),
        requestRetryInitialDelayMs: getPositiveNumberEnv('PYGEM_REQUEST_RETRY_INITIAL_DELAY_MS', 10000, { integer: true, minimum: 1000 }),
        requestRetryMaxDelayMs: getPositiveNumberEnv('PYGEM_REQUEST_RETRY_MAX_DELAY_MS', 60000, { integer: true, minimum: 1000 }),
        requestRetryJitterRatio: getPositiveNumberEnv('PYGEM_REQUEST_RETRY_JITTER_RATIO', 0.25, { minimum: 0, maximum: 1 }),
        // Duas tentativas (modelo principal + fallback) e uma recuperação em
        // até três fragmentos cabem no mesmo limite, sem chamadas ilimitadas.
        maxApiCallsPerRootBlock: getPositiveNumberEnv('PYGEM_MAX_API_CALLS_PER_ROOT_BLOCK', 8, { integer: true, minimum: 2, maximum: 10 }),
        maxApiCallsPerFileMultiplier: getPositiveNumberEnv('PYGEM_MAX_API_CALLS_PER_FILE_MULTIPLIER', 2.5, { minimum: 1, maximum: 3 }),
        maxApiCallsPerFileReserve: getPositiveNumberEnv('PYGEM_MAX_API_CALLS_PER_FILE_RESERVE', 4, { integer: true, minimum: 0, maximum: 10 }),
    },
    processing: {
        singlePassMaxInputTokens: getPositiveNumberEnv('PYGEM_SINGLE_PASS_MAX_INPUT_TOKENS', 1600, { integer: true, minimum: 500 }),
        blockInputTokens: getPositiveNumberEnv('PYGEM_BLOCK_INPUT_TOKENS', 1200, { integer: true, minimum: 500 }),
        minRecoveryBlockTokens: getPositiveNumberEnv('PYGEM_MIN_RECOVERY_BLOCK_TOKENS', 300, { integer: true, minimum: 150 }),
        maxBlockSubdivisionDepth: getPositiveNumberEnv('PYGEM_MAX_BLOCK_SUBDIVISION_DEPTH', 3, { integer: true, maximum: 4 }),
    },
    checkpoint: {
        enabled: process.env.PYGEM_CHECKPOINT_ENABLED !== 'false',
    },
    modelPolicy: {
        gemini3ThinkingLevel: supportedThinkingLevels.has(requestedThinkingLevel)
            ? requestedThinkingLevel
            : 'MINIMAL',
    },
    safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
    delays: {
        betweenFiles: 3000,
        betweenBlocks: 5000,
        betweenDirectories: 5000,
        onError: 15000,
        onQuotaError: 120000,
    },

    getVertexInfo() {
        return {
            project: this.project,
            location: this.location,
            apiVersion: this.apiVersion,
            model: this.model,
            authentication: 'Application Default Credentials (ADC)',
        };
    },

    hasValidVertexConfig() {
        if (!this.project) {
            console.error('❌ Projeto Google Cloud não configurado.');
            console.error('   Configure GOOGLE_CLOUD_PROJECT no arquivo .env.');
            return false;
        }

        if (!this.location) {
            console.error('❌ Região do Vertex AI não configurada.');
            console.error('   Configure GOOGLE_CLOUD_LOCATION no arquivo .env.');
            return false;
        }

        const compatibilityIssues = [
            ...getModelCompatibilityIssues(this.model, this.location),
            ...getModelCompatibilityIssues(this.fallbackModel, this.location),
            ...getModelCompatibilityIssues(this.recoveryModel, this.recoveryLocation),
        ];
        if (compatibilityIssues.length > 0) {
            compatibilityIssues.forEach(issue => console.error(`❌ ${issue}`));
            return false;
        }

        return true;
    },

};

config.getModelCompatibilityIssues = getModelCompatibilityIssues;

// Normaliza relações entre opções configuráveis para impedir combinações
// contraditórias vindas do ambiente.
config.retry.requestRetryMaxDelayMs = Math.max(
    config.retry.requestRetryInitialDelayMs,
    config.retry.requestRetryMaxDelayMs
);
config.outputPolicy.minOutputTokens = Math.min(
    config.outputPolicy.minOutputTokens,
    config.outputPolicy.maxOutputTokensPerRequest,
    config.generationConfig.maxOutputTokens
);
config.outputPolicy.maxOutputTokensPerRequest = Math.min(
    config.outputPolicy.maxOutputTokensPerRequest,
    config.generationConfig.maxOutputTokens
);
config.processing.blockInputTokens = Math.min(
    config.processing.singlePassMaxInputTokens,
    config.processing.blockInputTokens
);
config.processing.minRecoveryBlockTokens = Math.min(
    config.processing.minRecoveryBlockTokens,
    Math.max(150, config.processing.blockInputTokens - 1)
);

module.exports = config;
