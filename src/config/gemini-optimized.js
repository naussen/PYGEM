require('dotenv').config();

const baseConfig = require('./gemini');

function getPositiveIntegerEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

const config = {
    ...baseConfig,
    generationConfig: {
        ...baseConfig.generationConfig,
        // O modo otimizado reduz esperas, mas não aumenta a aleatoriedade da
        // reescrita: fidelidade e estabilidade devem ser iguais nos dois modos.
        temperature: baseConfig.generationConfig.temperature,
        topP: baseConfig.generationConfig.topP,
        topK: baseConfig.generationConfig.topK,
    },
    delays: {
        betweenFiles: 2000,
        betweenBlocks: 3000,
        betweenDirectories: 5000,
        onError: 8000,
        onQuotaError: 60000,
        adaptive: {
            enabled: true,
            smallFile: 1000,
            mediumFile: 3000,
            largeFile: 5000,
            smallFileThreshold: 1000,
            mediumFileThreshold: 3000,
        },
    },
    retry: {
        ...baseConfig.retry,
    },
    batch: {
        enabled: true,
        maxConcurrent: getPositiveIntegerEnv('PYGEM_MAX_CONCURRENT_REQUESTS', 1),
        smallFileThreshold: 2000,
        enableParallelProcessing: true,
    },

    getAdaptiveDelay(tokens, delayType = 'betweenFiles') {
        if (!this.delays.adaptive.enabled) {
            return this.delays[delayType];
        }

        if (delayType === 'betweenFiles') {
            if (tokens < this.delays.adaptive.smallFileThreshold) return this.delays.adaptive.smallFile;
            if (tokens < this.delays.adaptive.mediumFileThreshold) return this.delays.adaptive.mediumFile;
            return this.delays.adaptive.largeFile;
        }

        if (delayType === 'betweenBlocks') {
            if (tokens < 1000) return 2000;
            if (tokens < 2000) return 3000;
            return 5000;
        }

        return this.delays[delayType];
    },
};

module.exports = config;
