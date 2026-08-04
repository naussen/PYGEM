// src/services/performanceLogger.js
const fs = require('fs');
const path = require('path');
const config = require('../config/runtime');

class PerformanceLogger {
    constructor() {
        this.logDir = path.join(__dirname, '../../logs');
        this.sessionId = this.generateSessionId();
        this.sessionStart = Date.now();
        this.currentFile = null;
        this.currentFileStart = null;
        this.stats = {
            totalFiles: 0,
            processedFiles: 0,
            failedFiles: 0,
            totalTokens: 0,
            totalBlocks: 0,
            apiRequests: 0,
            apiErrors: 0,
            validationFailures: 0,
            truncatedResponses: 0,
            retries: 0,
            continuations: 0,
            totalProcessingTime: 0,
            totalDelayTime: 0,
            averageFileTime: 0,
            averageTokensPerSecond: 0
        };
        this.fileDetails = [];
        this.blockDetails = [];
        this.apiCalls = [];
        
        this.ensureLogDirectory();
        this.initializeSession();
    }

    generateSessionId() {
        const now = new Date();
        return `session_${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,'0')}${now.getDate().toString().padStart(2,'0')}_${now.getHours().toString().padStart(2,'0')}${now.getMinutes().toString().padStart(2,'0')}${now.getSeconds().toString().padStart(2,'0')}`;
    }

    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    initializeSession() {
        const sessionLog = {
            sessionId: this.sessionId,
            startTime: new Date().toISOString(),
            startTimestamp: this.sessionStart,
            config: {
                delays: config.delays,
                model: config.model,
                maxOutputTokens: config.generationConfig.maxOutputTokens,
                thinkingBudget: config.generationConfig.thinkingConfig?.thinkingBudget ?? null,
                authentication: 'ADC',
                project: config.project,
                location: config.location
            }
        };
        
        this.writeToFile('session_start.json', JSON.stringify(sessionLog, null, 2));
        console.log(`📊 Performance Logger iniciado - Session ID: ${this.sessionId}`);
    }

    startFileProcessing(fileName, filePath, estimatedTokens) {
        this.currentFile = {
            fileName,
            filePath,
            estimatedTokens,
            startTime: Date.now(),
            startTimeISO: new Date().toISOString(),
            blocks: [],
            apiCalls: [],
            processingMode: estimatedTokens > config.processing.singlePassMaxInputTokens
                ? 'blocks'
                : 'single'
        };
        
        this.stats.totalFiles++;
        this.stats.totalTokens += estimatedTokens;
        
        console.log(`📊 [${this.sessionId}] Iniciando processamento: ${fileName} (${estimatedTokens} tokens, modo: ${this.currentFile.processingMode})`);
    }

    logBlockStart(blockNumber, totalBlocks, blockTokens) {
        if (!this.currentFile) {
            this.stats.totalBlocks++;
            return;
        }
        
        const blockInfo = {
            blockNumber,
            totalBlocks,
            blockTokens,
            startTime: Date.now(),
            startTimeISO: new Date().toISOString()
        };
        
        this.currentFile.blocks.push(blockInfo);
        this.stats.totalBlocks++;
        
        console.log(`📊 [${this.sessionId}] Bloco ${blockNumber}/${totalBlocks} iniciado (${blockTokens} tokens)`);
    }

    logBlockEnd(blockNumber, success, errorMessage = null, outputLength = 0) {
        if (!this.currentFile) return;
        
        const block = this.currentFile.blocks.find(b => b.blockNumber === blockNumber);
        if (block) {
            block.endTime = Date.now();
            block.endTimeISO = new Date().toISOString();
            block.duration = block.endTime - block.startTime;
            block.success = success;
            block.errorMessage = errorMessage;
            block.outputLength = outputLength;
            block.tokensPerSecond = block.duration > 0 ? (block.blockTokens / (block.duration / 1000)) : 0;
            
            console.log(`📊 [${this.sessionId}] Bloco ${blockNumber} ${success ? 'concluído' : 'falhou'} (${block.duration}ms, ${block.tokensPerSecond.toFixed(2)} tokens/s)`);
        }
    }

    logApiCall({
        endpoint,
        model,
        inputTokens,
        outputTokens,
        duration,
        success,
        errorMessage = null,
        attempt = null,
        continuation = 0,
        finishReason = null,
        promptTokenCount = null,
        candidatesTokenCount = null,
        thoughtsTokenCount = null,
        totalTokenCount = null,
        outputLength = 0,
    }) {
        const apiCall = {
            timestamp: Date.now(),
            timestampISO: new Date().toISOString(),
            endpoint,
            model,
            inputTokens,
            outputTokens,
            duration,
            success,
            errorMessage,
            attempt,
            continuation,
            finishReason,
            usageMetadata: {
                promptTokenCount,
                candidatesTokenCount,
                thoughtsTokenCount,
                totalTokenCount,
            },
            outputLength,
            tokensPerSecond: duration > 0 ? ((inputTokens + outputTokens) / (duration / 1000)) : 0
        };
        
        this.apiCalls.push(apiCall);
        if (this.currentFile) {
            this.currentFile.apiCalls.push(apiCall);
        }
        
        this.stats.apiRequests++;
        if (!success) this.stats.apiErrors++;
        
        console.log(`📊 [${this.sessionId}] API Call: ${model} (${inputTokens}+${outputTokens} tokens, ${duration}ms, ${apiCall.tokensPerSecond.toFixed(2)} tokens/s)`);
    }

    recordGenerationEvent(type) {
        const supportedEvents = new Set([
            'validationFailures',
            'truncatedResponses',
            'retries',
            'continuations',
        ]);

        if (supportedEvents.has(type)) {
            this.stats[type]++;
        }
    }

    recordDelay(milliseconds, type = 'unknown') {
        const duration = Math.max(0, Number(milliseconds) || 0);
        this.stats.totalDelayTime += duration;
    }

    recordFileProcessing({
        fileName,
        filePath,
        estimatedTokens = 0,
        duration = 0,
        success,
        errorMessage = null,
        outputLength = 0,
    }) {
        const normalizedTokens = Math.max(0, Number(estimatedTokens) || 0);
        const normalizedDuration = Math.max(0, Number(duration) || 0);
        const details = {
            fileName,
            filePath,
            estimatedTokens: normalizedTokens,
            startTime: null,
            startTimeISO: null,
            blocks: [],
            apiCalls: [],
            processingMode: normalizedTokens > config.processing.singlePassMaxInputTokens
                ? 'blocks'
                : 'single',
            endTime: null,
            endTimeISO: null,
            duration: normalizedDuration,
            success: Boolean(success),
            errorMessage,
            outputLength,
            tokensPerSecond: normalizedDuration > 0
                ? normalizedTokens / (normalizedDuration / 1000)
                : 0,
        };

        this.fileDetails.push(details);
        this.stats.totalFiles++;
        this.stats.totalTokens += normalizedTokens;
        this.stats.totalProcessingTime += normalizedDuration;
        this.stats.averageFileTime = this.stats.totalFiles > 0
            ? this.stats.totalProcessingTime / this.stats.totalFiles
            : 0;
        this.stats.averageTokensPerSecond = this.stats.totalProcessingTime > 0
            ? this.stats.totalTokens / (this.stats.totalProcessingTime / 1000)
            : 0;

        if (success) this.stats.processedFiles++;
        else this.stats.failedFiles++;

        const safeName = String(fileName || 'arquivo').replace(/[^a-zA-Z0-9]/g, '_');
        this.writeToFile(`file_${safeName}.json`, JSON.stringify(details, null, 2));
    }

    endFileProcessing(success, errorMessage = null, outputLength = 0) {
        if (!this.currentFile) return;
        
        this.currentFile.endTime = Date.now();
        this.currentFile.endTimeISO = new Date().toISOString();
        this.currentFile.duration = this.currentFile.endTime - this.currentFile.startTime;
        this.currentFile.success = success;
        this.currentFile.errorMessage = errorMessage;
        this.currentFile.outputLength = outputLength;
        this.currentFile.tokensPerSecond = this.currentFile.duration > 0 ? (this.currentFile.estimatedTokens / (this.currentFile.duration / 1000)) : 0;
        
        // Calcula estatísticas dos blocos
        if (this.currentFile.blocks.length > 0) {
            const successfulBlocks = this.currentFile.blocks.filter(b => b.success);
            this.currentFile.blockStats = {
                totalBlocks: this.currentFile.blocks.length,
                successfulBlocks: successfulBlocks.length,
                averageBlockTime: successfulBlocks.length > 0 ? 
                    successfulBlocks.reduce((sum, b) => sum + b.duration, 0) / successfulBlocks.length : 0,
                averageBlockTokensPerSecond: successfulBlocks.length > 0 ?
                    successfulBlocks.reduce((sum, b) => sum + b.tokensPerSecond, 0) / successfulBlocks.length : 0
            };
        }
        
        this.fileDetails.push({ ...this.currentFile });
        
        if (success) {
            this.stats.processedFiles++;
        } else {
            this.stats.failedFiles++;
        }
        
        this.stats.totalProcessingTime += this.currentFile.duration;
        this.stats.averageFileTime = this.stats.totalProcessingTime / this.stats.totalFiles;
        this.stats.averageTokensPerSecond = this.stats.totalProcessingTime > 0 ? 
            (this.stats.totalTokens / (this.stats.totalProcessingTime / 1000)) : 0;
        
        console.log(`📊 [${this.sessionId}] Arquivo ${success ? 'concluído' : 'falhou'}: ${this.currentFile.fileName} (${this.currentFile.duration}ms, ${this.currentFile.tokensPerSecond.toFixed(2)} tokens/s)`);
        
        // Salva detalhes do arquivo
        this.writeToFile(`file_${this.currentFile.fileName.replace(/[^a-zA-Z0-9]/g, '_')}.json`, JSON.stringify(this.currentFile, null, 2));
        
        this.currentFile = null;
    }

    generateReport() {
        const sessionEnd = Date.now();
        const totalSessionTime = sessionEnd - this.sessionStart;
        
        const report = {
            sessionInfo: {
                sessionId: this.sessionId,
                startTime: new Date(this.sessionStart).toISOString(),
                endTime: new Date(sessionEnd).toISOString(),
                totalDuration: totalSessionTime,
                totalDurationFormatted: this.formatDuration(totalSessionTime)
            },
            summary: {
                ...this.stats,
                totalDurationFormatted: this.formatDuration(this.stats.totalProcessingTime),
                averageFileTimeFormatted: this.formatDuration(this.stats.averageFileTime),
                successRate: this.stats.totalFiles > 0 ? (this.stats.processedFiles / this.stats.totalFiles * 100) : 0
            },
            performance: {
                tokensPerSecond: this.stats.averageTokensPerSecond,
                filesPerHour: totalSessionTime > 0 ? (this.stats.processedFiles / (totalSessionTime / 3600000)) : 0,
                averageDelayImpact: this.calculateDelayImpact(),
                bottlenecks: this.identifyBottlenecks()
            },
            recommendations: this.generateRecommendations()
        };
        
        this.writeToFile('performance_report.json', JSON.stringify(report, null, 2));
        this.writeToFile('file_details.json', JSON.stringify(this.fileDetails, null, 2));
        this.writeToFile('api_calls.json', JSON.stringify(this.apiCalls, null, 2));
        
        return report;
    }

    calculateDelayImpact() {
        const totalDelayTime = this.stats.totalDelayTime;
        
        return {
            totalDelayTime,
            totalDelayTimeFormatted: this.formatDuration(totalDelayTime),
            percentageOfTotalTime: this.stats.totalProcessingTime > 0 ? 
                (totalDelayTime / this.stats.totalProcessingTime * 100) : 0
        };
    }

    identifyBottlenecks() {
        const bottlenecks = [];
        
        // Analisa tempo médio por arquivo
        if (this.stats.averageFileTime > 300000) { // > 5 minutos
            bottlenecks.push({
                type: 'slow_file_processing',
                severity: 'high',
                description: 'Tempo médio por arquivo muito alto',
                value: this.stats.averageFileTime,
                recommendation: 'Considere reduzir delays ou otimizar prompts'
            });
        }
        
        // Analisa taxa de tokens por segundo
        if (this.stats.averageTokensPerSecond < 10) {
            bottlenecks.push({
                type: 'low_throughput',
                severity: 'medium',
                description: 'Taxa de processamento de tokens baixa',
                value: this.stats.averageTokensPerSecond,
                recommendation: 'Verifique conectividade e considere modelo mais rápido'
            });
        }
        
        return bottlenecks;
    }

    generateRecommendations() {
        const recommendations = [];
        // Recomendações baseadas em performance
        if (this.stats.averageTokensPerSecond < 5) {
            recommendations.push({
                category: 'performance',
                priority: 'high',
                title: 'Otimizar velocidade de processamento',
                description: 'Taxa de tokens/segundo muito baixa',
                actions: [
                    'Medir latência e delays reais por bloco',
                    'Considerar o modelo fallback configurado para reduzir latência',
                    'Verificar conectividade de rede'
                ]
            });
        }
        
        // Recomendações baseadas em delays
        const delayImpact = this.calculateDelayImpact();
        if (delayImpact.percentageOfTotalTime > 50) {
            recommendations.push({
                category: 'delays',
                priority: 'high',
                title: 'Reduzir impacto dos delays',
                description: `Delays representam ${delayImpact.percentageOfTotalTime.toFixed(1)}% do tempo total`,
                actions: [
                    'Revisar os delays configurados após medir cotas e latência',
                    'Avaliar processamento paralelo somente após validar a telemetria',
                    'Considerar processamento paralelo de arquivos pequenos'
                ]
            });
        }
        
        if (this.stats.apiErrors > 0) {
            recommendations.push({
                category: 'vertex-api',
                priority: 'high',
                title: 'Investigar falhas da API Vertex AI',
                description: `${this.stats.apiErrors} requisições falharam na comunicação com o Vertex AI`,
                actions: [
                    'Revisar as cotas e os limites do projeto Vertex AI',
                    'Validar autenticação ADC e permissões IAM',
                    'Correlacionar status HTTP e mensagens registradas nas chamadas'
                ]
            });
        }

        if (this.stats.validationFailures > 0 || this.stats.truncatedResponses > 0) {
            recommendations.push({
                category: 'output-reliability',
                priority: 'high',
                title: 'Melhorar estabilidade da saída gerada',
                description: `${this.stats.validationFailures} rejeições locais e ${this.stats.truncatedResponses} respostas truncadas`,
                actions: [
                    'Revisar finishReason, comprimento e motivo de validação nos logs',
                    'Ajustar orçamento de saída ou divisão em blocos quando houver MAX_TOKENS',
                    'Reprocessar somente os arquivos que falharam'
                ]
            });
        } else if (this.stats.failedFiles > 0 && this.stats.apiErrors === 0) {
            recommendations.push({
                category: 'file-processing',
                priority: 'medium',
                title: 'Investigar falhas locais de processamento',
                description: `${this.stats.failedFiles} arquivos falharam sem erro identificado da API`,
                actions: [
                    'Revisar validação, leitura e gravação dos arquivos afetados',
                    'Consultar a mensagem detalhada de cada arquivo no relatório'
                ]
            });
        }
        
        return recommendations;
    }

    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    writeToFile(fileName, content, append = false) {
        const filePath = path.join(this.logDir, `${this.sessionId}_${fileName}`);
        
        try {
            if (append && fs.existsSync(filePath)) {
                const existingContent = fs.readFileSync(filePath, 'utf-8');
                let data;
                
                if (fileName.endsWith('.json')) {
                    try {
                        const existing = JSON.parse(existingContent);
                        const newData = JSON.parse(content);
                        
                        if (Array.isArray(existing)) {
                            data = JSON.stringify([...existing, newData], null, 2);
                        } else {
                            data = JSON.stringify([existing, newData], null, 2);
                        }
                    } catch {
                        data = existingContent + '\n' + content;
                    }
                } else {
                    data = existingContent + '\n' + content;
                }
                
                fs.writeFileSync(filePath, data, 'utf-8');
            } else {
                fs.writeFileSync(filePath, content, 'utf-8');
            }
        } catch (error) {
            console.error(`Erro ao escrever log: ${error.message}`);
        }
    }

    printSummary() {
        console.log('\n📊 RESUMO DE PERFORMANCE:');
        console.log(`⏱️  Tempo total de processamento: ${this.formatDuration(this.stats.totalProcessingTime)}`);
        console.log(`📄 Arquivos processados: ${this.stats.processedFiles}/${this.stats.totalFiles}`);
        console.log(`☁️  Erros reais da API: ${this.stats.apiErrors}`);
        console.log(`⚠️  Rejeições locais: ${this.stats.validationFailures}`);
        console.log(`✂️  Respostas truncadas: ${this.stats.truncatedResponses}`);
        console.log(`🔢 Total de tokens: ${this.stats.totalTokens.toLocaleString()}`);
        console.log(`⚡ Velocidade média: ${this.stats.averageTokensPerSecond.toFixed(2)} tokens/segundo`);
        console.log(`📊 Tempo médio por arquivo: ${this.formatDuration(this.stats.averageFileTime)}`);
        console.log(`📁 Logs salvos em: ${this.logDir}`);
    }
}

module.exports = PerformanceLogger;
