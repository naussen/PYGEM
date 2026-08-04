require('dotenv').config();

const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global';

function getPositiveNumberEnv(name, fallback, { integer = false, minimum = 0 } = {}) {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
    return integer ? Math.floor(parsed) : parsed;
}

const config = {
    project,
    location,
    apiVersion: process.env.GOOGLE_GENAI_API_VERSION?.trim() || 'v1',
    model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-2.5-flash-lite',
    generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        topK: 20,
        maxOutputTokens: 65536,
        candidateCount: 1,
        stopSequences: [],
        // Reescrita é uma tarefa transformacional. Um orçamento dinâmico de
        // thinking pode consumir o limite antes de o Markdown ser concluído.
        thinkingConfig: {
            thinkingBudget: getPositiveNumberEnv('PYGEM_THINKING_BUDGET', 0, { integer: true }),
            includeThoughts: false,
        },
    },
    outputPolicy: {
        maxOutputRatio: getPositiveNumberEnv('PYGEM_MAX_OUTPUT_RATIO', 3, { minimum: 1 }),
        maxOutputTokenMultiplier: getPositiveNumberEnv('PYGEM_MAX_OUTPUT_TOKEN_MULTIPLIER', 1.25, { minimum: 1 }),
        minOutputTokens: getPositiveNumberEnv('PYGEM_MIN_OUTPUT_TOKENS', 2048, { integer: true, minimum: 1 }),
    },
    retry: {
        maxFileRetries: getPositiveNumberEnv('PYGEM_MAX_FILE_RETRIES', 2, { integer: true }),
        maxGenerationAttempts: getPositiveNumberEnv('PYGEM_MAX_GENERATION_ATTEMPTS', 3, { integer: true, minimum: 1 }),
        maxContinuationCount: getPositiveNumberEnv('PYGEM_MAX_CONTINUATIONS', 2, { integer: true }),
        continuationMinInputTokens: getPositiveNumberEnv('PYGEM_CONTINUATION_MIN_INPUT_TOKENS', 5000, { integer: true, minimum: 1 }),
    },
    processing: {
        singlePassMaxInputTokens: getPositiveNumberEnv('PYGEM_SINGLE_PASS_MAX_INPUT_TOKENS', 2200, { integer: true, minimum: 500 }),
        blockInputTokens: getPositiveNumberEnv('PYGEM_BLOCK_INPUT_TOKENS', 1800, { integer: true, minimum: 500 }),
        minRecoveryBlockTokens: getPositiveNumberEnv('PYGEM_MIN_RECOVERY_BLOCK_TOKENS', 600, { integer: true, minimum: 250 }),
        maxBlockSubdivisionDepth: getPositiveNumberEnv('PYGEM_MAX_BLOCK_SUBDIVISION_DEPTH', 1, { integer: true }),
    },
    safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
    delays: {
        betweenFiles: 5000,
        betweenBlocks: 25000,
        betweenDirectories: 30000,
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

        return true;
    },

};

module.exports = config;
