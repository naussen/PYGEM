// src/services/parallelProcessingService.js
// Serviço para processamento paralelo de arquivos usando o Vertex AI

const fs = require('fs');
const path = require('path');
const geminiService = require('./geminiService');
const { estimateTokens } = require('./tokenService');
const { prepareContentForRewrite, finalizeRewrittenContent } = require('../utils/contentPreprocessor');
const { assertValidGeneratedContent } = require('../utils/validation');
const logger = require('../utils/logger');

class ParallelProcessingService {
    constructor(config) {
        this.config = config;
        this.activeProcesses = new Map();
        this.processQueue = [];
        this.maxConcurrent = config.batch?.maxConcurrent || 2;
        this.smallFileThreshold = config.batch?.smallFileThreshold || 2000;
    }

    /**
     * Determina se um arquivo deve ser processado em paralelo
     */
    shouldProcessInParallel(tokens) {
        return this.config.batch?.enabled && 
               this.config.batch?.enableParallelProcessing && 
               tokens < this.smallFileThreshold;
    }

    /**
     * Processa múltiplos arquivos em paralelo
     */
    async processFilesInParallel(files, prompt, options = {}) {
        const { replaceOriginal = false, deleteOriginal = false, outputDir = null } = options;
        const results = [];
        const errors = [];
        
        logger.info(`Iniciando processamento paralelo de ${files.length} arquivos`);
        console.log(`🚀 Processamento paralelo: ${files.length} arquivos (máx ${this.maxConcurrent} simultâneos)`);
        
        // Divide os arquivos em lotes para processamento paralelo
        const batches = this.createBatches(files);
        
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            console.log(`\n📦 Processando lote ${batchIndex + 1}/${batches.length} (${batch.length} arquivos)`);
            
            // Processa arquivos do lote em paralelo
            const batchPromises = batch.map((file, index) => 
                this.processFileWithDedicatedKey(file, prompt, index, options)
            );
            
            try {
                const batchResults = await Promise.allSettled(batchPromises);
                
                // Processa resultados do lote
                batchResults.forEach((result, index) => {
                    const file = batch[index];
                    if (result.status === 'fulfilled') {
                        results.push({
                            file: file.path,
                            success: true,
                            content: result.value.content,
                            tokens: result.value.tokens,
                            processingTime: result.value.processingTime
                        });
                        console.log(`  ✅ ${path.basename(file.path)} processado com sucesso`);
                    } else {
                        const error = `Erro em ${path.basename(file.path)}: ${result.reason.message}`;
                        errors.push(error);
                        results.push({
                            file: file.path,
                            success: false,
                            error: result.reason.message
                        });
                        console.log(`  ❌ ${path.basename(file.path)}: ${result.reason.message}`);
                    }
                });
                
                // Delay entre lotes (se não for o último)
                if (batchIndex < batches.length - 1) {
                    const delayMs = this.config.delays.betweenFiles;
                    console.log(`  ⏳ Aguardando ${delayMs/1000}s antes do próximo lote...`);
                    global.performanceLogger?.recordDelay(delayMs, 'betweenFiles');
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                
            } catch (error) {
                logger.error(`Erro no processamento do lote ${batchIndex + 1}: ${error.message}`);
                console.log(`❌ Erro no lote ${batchIndex + 1}: ${error.message}`);
            }
        }
        
        return {
            results,
            errors,
            totalFiles: files.length,
            successCount: results.filter(r => r.success).length,
            errorCount: errors.length
        };
    }

    /**
     * Cria lotes de arquivos para processamento paralelo
     */
    createBatches(files) {
        const batches = [];
        for (let i = 0; i < files.length; i += this.maxConcurrent) {
            batches.push(files.slice(i, i + this.maxConcurrent));
        }
        return batches;
    }

    /**
     * Processa um arquivo em paralelo usando a configuração compartilhada do Vertex AI.
     */
    async processFileWithDedicatedKey(file, prompt, keyOffset = 0, options = {}) {
        const startTime = Date.now();
        const fileName = path.basename(file.path);
        
        try {
            // Lê o conteúdo do arquivo
            const rawContent = fs.readFileSync(file.path, 'utf-8');

            if (rawContent.trim().length === 0) {
                throw new Error('Arquivo vazio');
            }

            const prepared = prepareContentForRewrite(rawContent);
            const content = prepared.text;
            const estimatedTokens = estimateTokens(content);
            
            let rewrittenContent;
            if (estimatedTokens > 5000) {
                rewrittenContent = await geminiService.rewriteContentInBlocks(content, prompt, fileName);
            } else {
                rewrittenContent = await geminiService.rewriteContent(content, prompt);
            }

            rewrittenContent = finalizeRewrittenContent(rewrittenContent, prepared);

            // Salva o arquivo processado
            await this.saveProcessedFile(file, rewrittenContent, options);

            const processingTime = Date.now() - startTime;

            return {
                content: rewrittenContent,
                tokens: estimatedTokens,
                processingTime
            };
            
        } catch (error) {
            logger.error(`Erro ao processar arquivo ${fileName}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Salva o arquivo processado
     */
    async saveProcessedFile(file, content, options) {
        const { replaceOriginal = false, deleteOriginal = false, outputDir = null } = options;
        assertValidGeneratedContent(content);
        
        if (replaceOriginal) {
            // Substitui o arquivo original
            fs.writeFileSync(file.path, content, 'utf-8');
            logger.info(`Arquivo original substituído: ${file.path}`);
        } else {
            // Salva em novo arquivo
            const fileName = path.basename(file.path);
            const dirName = path.basename(path.dirname(file.path));
            const outputPath = path.join(outputDir, `${dirName}_${fileName}`);
            
            // Cria o diretório se não existir
            const outputDirPath = path.dirname(outputPath);
            if (!fs.existsSync(outputDirPath)) {
                fs.mkdirSync(outputDirPath, { recursive: true });
            }
            
            fs.writeFileSync(outputPath, content, 'utf-8');
            logger.info(`Arquivo salvo: ${outputPath}`);
            
            // Se solicitado, exclui o arquivo original
            if (deleteOriginal) {
                fs.unlinkSync(file.path);
                logger.info(`Arquivo original excluído: ${file.path}`);
            }
        }
    }

    /**
     * Agrupa arquivos por tamanho para otimizar o processamento
     */
    groupFilesBySize(files) {
        const smallFiles = [];
        const largeFiles = [];
        
        files.forEach(file => {
            try {
                const content = fs.readFileSync(file.path, 'utf-8');
                const tokens = estimateTokens(content);
                
                if (tokens < this.smallFileThreshold) {
                    smallFiles.push({ ...file, tokens });
                } else {
                    largeFiles.push({ ...file, tokens });
                }
            } catch (error) {
                logger.warn(`Erro ao ler arquivo ${file.path}: ${error.message}`);
                largeFiles.push({ ...file, tokens: 0 });
            }
        });
        
        return { smallFiles, largeFiles };
    }

    /**
     * Obtém estatísticas do processamento paralelo
     */
    getProcessingStats() {
        return {
            maxConcurrent: this.maxConcurrent,
            smallFileThreshold: this.smallFileThreshold,
            activeProcesses: this.activeProcesses.size,
            queueLength: this.processQueue.length
        };
    }
}

module.exports = ParallelProcessingService;
