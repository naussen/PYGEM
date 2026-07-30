require('dotenv').config();

const baseConfig = require('./gemini');

const config = {
    ...baseConfig,
    generationConfig: {
        ...baseConfig.generationConfig,
        temperature: 0.7,
        topP: 0.95,
        topK: 64,
    },
    delays: {
        betweenFiles: 3000,
        betweenBlocks: 20000,
        betweenDirectories: 10000,
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
        maxRetries: 3,
        backoffMultiplier: 1.5,
        initialDelay: 5000,
        maxDelay: 60000,
    },
    batch: {
        enabled: true,
        maxConcurrent: 2,
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
            if (tokens < 2000) return 15000;
            if (tokens < 4000) return 18000;
            return 20000;
        }

        return this.delays[delayType];
    },

    getRetryDelay(retryCount) {
        const delay = this.retry.initialDelay * Math.pow(this.retry.backoffMultiplier, retryCount);
        return Math.min(delay, this.retry.maxDelay);
    },
};

module.exports = config;
