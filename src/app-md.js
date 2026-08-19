require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline-sync');
const {
    validateDirectory,
    assertValidGeneratedContent,
    assertSourceHeadingCoverage,
} = require('./utils/validation');
const {
    readMdFiles,
    createOutputDirectory,
    readAllMdFilesInSubdirectories,
    writeRewrittenFileAtomic,
    writeDirectoryProcessingManifest,
    getReusableManifestEntries,
} = require('./services/fileServiceMd');
const { estimateTokens } = require('./services/tokenService');
const geminiService = require('./services/geminiService');
const ParallelProcessingService = require('./services/parallelProcessingService');
const { getRewritingPrompt } = require('./services/promptServiceMd');
const { applyContentEnhancements, normalizeUppercaseHeadings } = require('./utils/contentProcessor');
const { prepareContentForRewrite, finalizeRewrittenContent } = require('./utils/contentPreprocessor');
const logger = require('./utils/logger');
const powerService = require('./services/powerService');
const PerformanceLogger = require('./services/performanceLogger');
const { sha256 } = require('./visual/visualGuideCompiler');
const {
    parseVisualOptions,
    loadVisualContext,
    selectVisualTopicsForFile,
    writeVisualPlanAtomic,
} = require('./visual/visualContextService');
const { assertVisualCompliance } = require('./visual/visualComplianceValidator');

// Permite escolher entre configuração normal ou otimizada
const useOptimizedConfig = process.env.USE_OPTIMIZED_CONFIG === 'true' || process.argv.includes('--optimized');
const config = require('./config/runtime');

async function main() {
    let autoShutdown = false;
    let performanceLogger = null;
    
    try {
        console.log('🚀 Iniciando PYGEM - Reescrita Didática com Vertex AI...');
        console.log('✨ Recursos: remoção de números de módulo + geração de índice');
        if (useOptimizedConfig) {
            console.log('⚡ Usando configuração otimizada para melhor performance!');
        }
        logger.info('Iniciando Vertex AI Markdown Rewriter...');

        const visualOptions = parseVisualOptions(process.argv.slice(2), process.env);
        const visualContext = loadVisualContext(visualOptions);
        if (visualContext) {
            console.log(
                `🎨 Plano visual v1 carregado: ${visualContext.plan.topics.length} tópico(s), `
                + `origem ${path.basename(visualContext.inputPath)}`
            );
            logger.info(
                `Plano visual carregado (${visualContext.inputType}, `
                + `${visualContext.plan.topics.length} tópicos, hash ${visualContext.planHash.slice(0, 12)}).`
            );
        }
        
        // Inicializa o performance logger
        performanceLogger = new PerformanceLogger();
        performanceLogger.stats.configType = useOptimizedConfig ? 'optimized' : 'standard';
        
        // Torna o performance logger disponível globalmente para outros serviços
        global.performanceLogger = performanceLogger;
        
        // Inicializar serviço de processamento paralelo
        const parallelService = new ParallelProcessingService(config);

        // Verifica os parâmetros necessários para inicializar o Vertex AI.
        if (!config.hasValidVertexConfig()) {
            logger.error('Configuração do Vertex AI incompleta');
            console.error('\n❌ Erro na configuração do Vertex AI:');
            console.error('\nVerifique se:');
            console.error('1. Você tem um arquivo .env na raiz do projeto');
            console.error('2. GOOGLE_CLOUD_PROJECT está configurado no .env');
            console.error('3. GOOGLE_CLOUD_LOCATION está configurado no .env');
            console.error('4. As credenciais ADC foram criadas com "gcloud auth application-default login"');
            return;
        }

        const vertexInfo = config.getVertexInfo();
        console.log(`☁️ Projeto Vertex AI: ${vertexInfo.project}`);
        console.log(`📍 Região: ${vertexInfo.location}`);
        console.log(`🔐 Autenticação: ${vertexInfo.authentication}`);
        logger.info(`Vertex AI configurado: projeto ${vertexInfo.project}, região ${vertexInfo.location}`);

        // O teste pode ser dispensado em execuções automatizadas para evitar uma chamada extra.
        const skipConnectionTest = process.env.PYGEM_SKIP_CONNECTION_TEST === 'true';
        let connectionTest = {
            success: true,
            message: 'Teste de conexão dispensado por configuração.',
            model: config.model,
        };

        if (skipConnectionTest) {
            console.log('⏭️ Teste inicial de conexão dispensado (PYGEM_SKIP_CONNECTION_TEST=true).');
            logger.info('Teste inicial de conexão dispensado por configuração.');
        } else {
            console.log('🔍 Testando conexão com o Vertex AI...');
            logger.info('Testando conexão com o Vertex AI...');
            connectionTest = await geminiService.testConnection();

            if (!connectionTest.success) {
                logger.error(connectionTest.error);
                console.error('\n❌ Erro na configuração do Vertex AI:');
                console.error(connectionTest.error);
                console.error('\nVerifique as credenciais ADC, a API Vertex AI e as permissões IAM.');
                return;
            }
        }

        logger.info(connectionTest.message);
        console.log(`✅ Conectado ao Vertex AI (modelo: ${connectionTest.model})\n`);

        // Execuções automatizadas não devem ficar bloqueadas em um prompt sem TTY.
        const configuredShutdown = process.env.PYGEM_AUTO_SHUTDOWN?.trim().toLowerCase();
        const shutdownOption = configuredShutdown ?? readline
            .question('🔌 Desligar o computador automaticamente após o processamento? (s/N): ')
            .toLowerCase();
        autoShutdown = ['true', '1', 's', 'sim', 'y', 'yes'].includes(shutdownOption);
        
        if (autoShutdown) {
            console.log('⚠️  O computador será desligado automaticamente após o processamento!');
            logger.info('Desligamento automático ativado');
        }

        // Inicia a prevenção de suspensão
        console.log('🛡️  Prevenindo suspensão do sistema...');
        powerService.preventSleep();
        logger.info('Prevenção de suspensão ativada');

        // Solicitar diretório de entrada
        const inputDirectory = process.env.INPUT_DIR || readline.question('📁 Digite o caminho do diretório de ENTRADA (arquivos .md): ');

        if (!validateDirectory(inputDirectory)) {
            logger.error(`Diretório de entrada inválido: ${inputDirectory}`);
            console.error('❌ Diretório de entrada inválido. Verifique o caminho e tente novamente.');
            return;
        }

        // Solicitar diretório de saída
        const outputDirectory = process.env.OUTPUT_DIR || readline.question('📂 Digite o caminho do diretório de SAÍDA (arquivos processados): ');

        if (!outputDirectory.trim()) {
            console.error('❌ Diretório de saída é obrigatório!');
            return;
        }

        // CONFIGURAÇÃO SIMPLIFICADA - SEMPRE CRIA NOVOS ARQUIVOS NA PASTA DE SAÍDA
        console.log('\n📤 CONFIGURAÇÃO DE SAÍDA:');
        console.log('=============================');
        console.log('✅ Arquivos originais serão preservados na pasta de entrada');
        console.log('✅ Arquivos reescritos serão salvos na pasta de saída especificada');
        console.log('✅ Remoção automática de números de módulo (ex: "MÓDULO 2:")');
        console.log('✅ Geração automática de índice no início dos arquivos');
        
        const replaceOriginal = false;  // Nunca substituir originais
        const deleteOriginal = false;   // Nunca deletar originais

        // Lê os arquivos .md de todas as subpastas
        const directoriesWithFiles = readAllMdFilesInSubdirectories(inputDirectory);
        if (directoriesWithFiles.length === 0) {
            logger.warn(`Nenhum arquivo .md encontrado em: ${inputDirectory} ou suas subpastas`);
            console.log('⚠️  Nenhum arquivo .md encontrado no diretório especificado ou suas subpastas.');
            return;
        }

        // Conta o total de arquivos
        const totalFiles = directoriesWithFiles.reduce((total, dir) => total + dir.files.length, 0);
        const totalDirs = directoriesWithFiles.length;
        
        // Calcula estatísticas dos arquivos para otimização
        const allFiles = directoriesWithFiles.flatMap(dir => dir.files);
        const fileSizes = allFiles.map(file => {
            try {
                const content = fs.readFileSync(file, 'utf-8');
                return estimateTokens(content);
            } catch {
                return 0;
            }
        });
        const averageTokens = fileSizes.length > 0 ? fileSizes.reduce((a, b) => a + b, 0) / fileSizes.length : 0;
        
        // Aplica configuração otimizada baseada no contexto
        const optimizedConfig = config.getOptimizedConfig ? 
            config.getOptimizedConfig({ fileCount: totalFiles, averageTokens }) : config;
        
        logger.info(`Encontrados ${totalFiles} arquivos .md em ${totalDirs} diretórios/subpastas`);
        console.log(`📄 Encontrados ${totalFiles} arquivo(s) .md em ${totalDirs} diretório(s)/subpasta(s) para processar`);
        console.log(`📊 Tamanho médio: ${averageTokens.toFixed(0)} tokens por arquivo`);
        if (useOptimizedConfig) {
            console.log(`⚡ Delays otimizados: ${optimizedConfig.delays.betweenFiles/1000}s entre arquivos, ${optimizedConfig.delays.betweenBlocks/1000}s entre blocos\n`);
        } else {
            console.log(`⏱️  Delays padrão: ${config.delays.betweenFiles/1000}s entre arquivos, ${config.delays.betweenBlocks/1000}s entre blocos\n`);
        }

        // Cria o diretório de saída
        createOutputDirectory(outputDirectory);
        if (visualContext) {
            const persistedVisualPlan = writeVisualPlanAtomic(outputDirectory, visualContext.plan);
            console.log(`🎨 Plano visual normalizado salvo: ${persistedVisualPlan}`);
        }

        // Obtém o prompt de reescrita
        const prompt = getRewritingPrompt();
        const generationFingerprint = sha256(JSON.stringify({
            schemaVersion: 1,
            model: config.model,
            basePromptHash: sha256(prompt),
            visualPlanHash: visualContext?.planHash || null,
        }));

        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        const directoryResults = [];

        // Processa cada diretório
        for (let dirIndex = 0; dirIndex < directoriesWithFiles.length; dirIndex++) {
            const dirInfo = directoriesWithFiles[dirIndex];
            const dirPath = dirInfo.directory;
            const mdFiles = dirInfo.files;
            const reusableEntries = getReusableManifestEntries(
                outputDirectory,
                inputDirectory,
                dirPath,
                mdFiles,
                { generationFingerprint }
            );
            const reusablePaths = new Set(
                reusableEntries.map(entry => path.resolve(entry.filePath))
            );
            const dirSuccessfulEntries = [...reusableEntries];
            const dirFailedEntries = [];
            successCount += reusableEntries.length;
            
            console.log(`\n📁 Processando diretório (${dirIndex + 1}/${directoriesWithFiles.length}): ${dirPath}`);
            logger.info(`Processando diretório: ${dirPath} com ${mdFiles.length} arquivos`);
            if (reusableEntries.length > 0) {
                console.log(
                    `  ♻️ ${reusableEntries.length} arquivo(s) já publicado(s) e inalterado(s) `
                    + 'serão reutilizados pelo manifesto.'
                );
            }
            
            // Analisar arquivos para decidir estratégia de processamento
            const inspectedFiles = mdFiles
                .filter(file => !reusablePaths.has(path.resolve(file)))
                .map(file => {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const tokens = estimateTokens(content);
                    if (!content.trim()) {
                        return {
                            path: file,
                            name: path.basename(file),
                            content,
                            tokens,
                            visualTopics: [],
                            visualPlanHash: visualContext?.planHash || null,
                            prompt,
                            readError: 'Arquivo vazio',
                        };
                    }
                    const visualTopics = visualContext
                        ? selectVisualTopicsForFile(file, content, visualContext.plan)
                        : [];
                    return {
                        path: file,
                        name: path.basename(file),
                        content,
                        tokens,
                        visualTopics,
                        visualPlanHash: visualContext?.planHash || null,
                        prompt: visualTopics.length > 0
                            ? getRewritingPrompt({ visualTopics })
                            : prompt,
                        readError: null,
                    };
                } catch (error) {
                    return {
                        path: file,
                        name: path.basename(file),
                        content: '',
                        tokens: 0,
                        readError: `Falha de leitura: ${error.message}`,
                    };
                }
            });
            const filesWithContent = inspectedFiles.filter(file => !file.readError);

            inspectedFiles.filter(file => file.readError).forEach(file => {
                const errorMessage = `Erro ao processar ${file.name}: ${file.readError}`;
                dirFailedEntries.push({
                    filePath: file.path,
                    error: file.readError,
                });
                errorCount++;
                errors.push(errorMessage);
                logger.error(errorMessage);
                performanceLogger.recordFileProcessing({
                    fileName: file.name,
                    filePath: file.path,
                    estimatedTokens: file.tokens,
                    success: false,
                    errorMessage: file.readError,
                });
            });
            
            const { smallFiles, largeFiles } = parallelService.groupFilesBySize(filesWithContent);
            
            console.log(`  📊 Análise: ${smallFiles.length} arquivos pequenos, ${largeFiles.length} arquivos grandes`);
            
            // Processar arquivos pequenos em paralelo (se habilitado)
            if (smallFiles.length > 0 && config.batch?.enableParallelProcessing) {
                console.log(`\n🚀 Processamento paralelo de ${smallFiles.length} arquivos pequenos`);
                
                const parallelOptions = {
                    replaceOriginal,
                    deleteOriginal,
                    outputDir: replaceOriginal ? null : outputDirectory,
                    // A publicação individual e atômica é centralizada neste fluxo.
                    deferWrite: true,
                };
                
                const parallelResults = await parallelService.processFilesInParallel(
                    smallFiles, 
                    prompt, 
                    parallelOptions
                );
                
                // Publica e registra os resultados do processamento paralelo.
                parallelResults.results.forEach(result => {
                    const resultFileName = path.basename(result.file || 'arquivo');
                    if (result.success) {
                        try {
                            const outputFilePath = writeRewrittenFileAtomic(
                                outputDirectory,
                                inputDirectory,
                                result.file,
                                result.content
                            );
                            dirSuccessfulEntries.push({
                                filePath: result.file,
                                outputFilePath,
                            });
                            successCount++;
                            console.log(`    ✅ Salvo: ${outputFilePath}`);
                        } catch (error) {
                            result.success = false;
                            result.error = `Falha ao publicar resultado validado: ${error.message}`;
                        }
                    }

                    if (!result.success) {
                        dirFailedEntries.push({ filePath: result.file, error: result.error });
                        errorCount++;
                        const errorMessage = `Erro ao processar ${resultFileName}: ${result.error}`;
                        errors.push(errorMessage);
                        logger.error(errorMessage);
                        console.log(`    ❌ Erro: ${result.error}`);
                    }

                    performanceLogger.recordFileProcessing({
                        fileName: resultFileName,
                        filePath: result.file,
                        estimatedTokens: result.tokens || 0,
                        duration: result.processingTime || 0,
                        success: result.success,
                        errorMessage: result.error || null,
                        outputLength: result.success ? (result.content?.length || 0) : 0,
                    });
                });
                
                const publishedParallelCount = parallelResults.results.filter(result => result.success).length;
                console.log(`✅ Processamento paralelo concluído: ${publishedParallelCount}/${parallelResults.totalFiles} arquivos publicados`);
            }
            
            // Processa arquivos grandes sequencialmente
             const filesToProcessSequentially = config.batch?.enableParallelProcessing ? largeFiles : filesWithContent;
             
             if (filesToProcessSequentially.length > 0) {
                 console.log(`\n📝 Processamento sequencial de ${filesToProcessSequentially.length} arquivos${config.batch?.enableParallelProcessing ? ' grandes' : ''}`);
             }
             
             for (let i = 0; i < filesToProcessSequentially.length; i++) {
                 const fileData = filesToProcessSequentially[i];
                 const file = fileData.path;
                 const fileName = fileData.name;
                
                try {
                    console.log(`  🔄 Processando arquivo (${i + 1}/${filesToProcessSequentially.length}): ${fileName}`);
                    logger.info(`Processando arquivo: ${file}`);

                    // Usa o conteúdo já carregado (sem definições base64 de imagem)
                    const prepared = prepareContentForRewrite(fileData.content, fileName);
                    const content = prepared.text;
                    const estimatedTokens = estimateTokens(content);
                    console.log(`    📊 Arquivo contém aproximadamente ${estimatedTokens} tokens (${prepared.imageFooter ? 'imagens base64 separadas' : 'sem imagens base64'})`);
                    if (fileData.visualTopics.length > 0) {
                        console.log(
                            `    🎨 Contrato visual aplicado: ${fileData.visualTopics.length} tópico(s), `
                            + `${fileData.visualTopics.reduce((total, topic) => total + topic.requirements.length, 0)} requisito(s)`
                        );
                    }
                    
                    // Inicia o logging de performance para este arquivo
                    if (performanceLogger) {
                        performanceLogger.startFileProcessing(fileName, file, estimatedTokens);
                    }
                    
                    // Decide se processa em blocos ou de uma vez
                    let rewrittenContent;
                    if (geminiService.shouldRewriteInBlocks(estimatedTokens)) {
                        console.log(`    📦 Arquivo será processado em blocos (limite seguro: ${config.processing.singlePassMaxInputTokens} tokens)`);
                        rewrittenContent = await geminiService.rewriteContentInBlocks(
                            content,
                            fileData.prompt,
                            fileName,
                            {
                                visualPlanHash: fileData.visualPlanHash,
                                visualTopicSlugs: fileData.visualTopics.map(topic => topic.topic_slug),
                                visualTopics: fileData.visualTopics,
                            }
                        );
                    } else {
                        console.log(`    📄 Arquivo será processado de uma vez (até ${config.processing.singlePassMaxInputTokens} tokens)`);
                        rewrittenContent = await geminiService.rewriteContent(
                            content,
                            fileData.prompt,
                            {
                                visualPlanHash: fileData.visualPlanHash,
                                visualTopicSlugs: fileData.visualTopics.map(topic => topic.topic_slug),
                                visualTopics: fileData.visualTopics,
                            }
                        );
                    }

                    // APLICAR NOVOS RECURSOS
                    console.log(`    🔧 Aplicando recursos adicionais...`);
                    
                    // Aplicar todas as melhorias usando o utilitário
                    const enhancementResult = applyContentEnhancements(rewrittenContent, {
                        removeModules: true,
                        generateIndex: true,
                        indexOutputDirectory: outputDirectory,
                        logProgress: true
                    }, file);
                    
                    rewrittenContent = enhancementResult.processedContent;
                    rewrittenContent = finalizeRewrittenContent(rewrittenContent, prepared);
                    rewrittenContent = normalizeUppercaseHeadings(rewrittenContent);
                    assertValidGeneratedContent(rewrittenContent, {
                        sourceMarkdown: content,
                    });
                    assertSourceHeadingCoverage(content, rewrittenContent);
                    assertVisualCompliance(rewrittenContent, {
                        visualTopics: fileData.visualTopics,
                    });
                    
                    // Log das mudanças aplicadas
                    if (enhancementResult.hasChanges) {
                        enhancementResult.changes.forEach(change => {
                            console.log(`    ✅ ${change}`);
                        });
                    }

                    const outputFilePath = writeRewrittenFileAtomic(
                        outputDirectory,
                        inputDirectory,
                        file,
                        rewrittenContent
                    );
                    dirSuccessfulEntries.push({
                        filePath: file,
                        outputFilePath,
                    });
                    
                    successCount++;
                    logger.info(`Arquivo processado com sucesso: ${fileName}`);
                    console.log(`    ✅ Concluído: ${fileName}`);
                    console.log(`    💾 Salvo: ${outputFilePath}`);
                    
                    // Finaliza o logging de performance para este arquivo
                    if (performanceLogger) {
                        performanceLogger.endFileProcessing(true, null, rewrittenContent.length);
                    }

                    // Reinicializa o cliente Vertex AI entre documentos.
                    geminiService.refreshGeminiClient();
                    
                    // Exibe estatísticas da API
                    const apiStats = geminiService.getApiStats();
                    console.log(`    📊 Estatísticas API: ${apiStats.requests} requisições, ${apiStats.apiErrors} erros reais, ${apiStats.validationFailures} rejeições locais`);
                    
                    // Pausa configurável entre arquivos (exceto para o último arquivo do diretório)
                    if (i < filesToProcessSequentially.length - 1) {
                        // Usa delay adaptativo se disponível
                        const delayMs = (optimizedConfig.getAdaptiveDelay && useOptimizedConfig) ? 
                            optimizedConfig.getAdaptiveDelay(estimatedTokens, 'betweenFiles') : 
                            optimizedConfig.delays.betweenFiles;
                        
                        console.log(`    ⏳ Aguardando ${delayMs/1000} segundos antes do próximo arquivo...`);
                        performanceLogger.recordDelay(delayMs, 'betweenFiles');
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }

                } catch (error) {
                    dirFailedEntries.push({
                        filePath: file,
                        error: error.message,
                    });
                    errorCount++;
                    const errorMessage = `Erro ao processar ${fileName}: ${error.message}`;
                    errors.push(errorMessage);
                    logger.error(errorMessage);
                    console.log(`    ❌ Erro: ${error.message}`);
                    
                    // Finaliza o logging de performance para este arquivo com erro
                    if (performanceLogger) {
                        performanceLogger.endFileProcessing(false, error.message, 0);
                    }
                }
            }

            const directoryResult = writeDirectoryProcessingManifest(
                outputDirectory,
                inputDirectory,
                dirPath,
                mdFiles,
                dirSuccessfulEntries,
                dirFailedEntries,
                { generationFingerprint }
            );
            directoryResults.push({
                directory: dirPath,
                complete: directoryResult.complete,
                manifestPath: directoryResult.manifestPath,
                failedFiles: directoryResult.failedFiles,
            });

            if (directoryResult.complete) {
                console.log(`✅ Diretório concluído: ${dirSuccessfulEntries.length} arquivo(s) individual(is) publicado(s)`);
            } else {
                console.log(`⚠️ Diretório incompleto: ${dirSuccessfulEntries.length} arquivo(s) publicado(s)`);
                console.log(`   Manifesto: ${directoryResult.manifestPath}`);
                console.log(`   Arquivos com falha: ${directoryResult.failedFiles.length}`);
            }
            
            // Pausa configurável entre diretórios (exceto para o último diretório)
            if (dirIndex < directoriesWithFiles.length - 1) {
                const delayMs = optimizedConfig.delays.betweenDirectories;
                console.log(`\n⏳ Aguardando ${delayMs/1000} segundos antes do próximo diretório...`);
                performanceLogger.recordDelay(delayMs, 'betweenDirectories');
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        // Para a prevenção de suspensão
        powerService.stopPreventSleep();
        console.log('🛡️  Prevenção de suspensão desativada');
        logger.info('Prevenção de suspensão desativada');

        // Exibe o resumo final
        console.log('\n📊 RESUMO DO PROCESSAMENTO:');
        console.log(`✅ Arquivos processados com sucesso: ${successCount}`);
        console.log(`❌ Arquivos com erro: ${errorCount}`);
        console.log(`📁 Arquivos salvos em: ${outputDirectory}`);
        const incompleteDirectories = directoryResults.filter(result => !result.complete);
        console.log(`📚 Diretórios completos: ${directoryResults.length - incompleteDirectories.length}/${directoryResults.length}`);
        if (incompleteDirectories.length > 0) {
            console.log(`⚠️ Diretórios incompletos: ${incompleteDirectories.length}. Os arquivos concluídos permanecem disponíveis; consulte os manifestos para reprocessar apenas as falhas.`);
        }
        
        // Exibir informações sobre melhorias de performance
        if (config.batch?.enableParallelProcessing) {
            const stats = parallelService.getProcessingStats();
            console.log('\n🚀 MELHORIAS DE PERFORMANCE ATIVAS:');
            console.log(`   • Processamento paralelo habilitado (máx ${stats.maxConcurrent} simultâneos)`);
            console.log(`   • Threshold para arquivos pequenos: ${stats.smallFileThreshold} tokens`);
            console.log(`   • Delays otimizados: ${config.delays.betweenFiles/1000}s entre arquivos, ${config.delays.betweenBlocks/1000}s entre blocos`);
        }
        
        // Exibe estatísticas finais da API
        const finalApiStats = geminiService.getApiStats();
        console.log(`\n☁️ ESTATÍSTICAS DO VERTEX AI:`);
        console.log(`📊 Total de requisições: ${finalApiStats.requests}`);
        console.log(`❌ Erros reais da API: ${finalApiStats.apiErrors}`);
        console.log(`⚠️ Rejeições locais: ${finalApiStats.validationFailures}`);
        console.log(`✂️ Respostas truncadas: ${finalApiStats.truncatedResponses}`);
        console.log(`🔂 Loops de repetição detectados: ${finalApiStats.repetitionLoops}`);
        console.log(`↪️ Subdivisões de recuperação: ${finalApiStats.recoverySubdivisions}`);
        console.log(`📝 Blocos originais preservados: ${finalApiStats.preservedBlocks}`);
        console.log(`🔁 Retentativas de geração: ${finalApiStats.retries}`);
        console.log(`🎯 Modelo: ${finalApiStats.model}`);
        console.log(`☁️ Projeto/região: ${finalApiStats.project}/${finalApiStats.location}`);

        if (errors.length > 0) {
            console.log('\n❌ ERROS ENCONTRADOS:');
            errors.forEach((error, index) => {
                console.log(`  ${index + 1}. ${error}`);
            });
        }

        logger.info(`Processamento concluído. Sucessos: ${successCount}, Erros: ${errorCount}`);
        logger.info(`Estatísticas Vertex AI: ${finalApiStats.requests} requisições, ${finalApiStats.apiErrors} erros reais de API, ${finalApiStats.validationFailures} rejeições locais`);
        
        // Gera e exibe relatório de performance
        if (performanceLogger) {
            console.log('\n📊 Gerando relatório de performance...');
            const performanceReport = performanceLogger.generateReport();
            performanceLogger.printSummary();
            
            // Exibe recomendações se houver
            if (performanceReport.recommendations && performanceReport.recommendations.length > 0) {
                console.log('\n💡 RECOMENDAÇÕES PARA MELHORAR PERFORMANCE:');
                performanceReport.recommendations.forEach((rec, index) => {
                    console.log(`\n${index + 1}. ${rec.title} (${rec.priority})`);
                    console.log(`   ${rec.description}`);
                    rec.actions.forEach(action => {
                        console.log(`   • ${action}`);
                    });
                });
            }
            
            // Exibe bottlenecks identificados
            if (performanceReport.performance.bottlenecks && performanceReport.performance.bottlenecks.length > 0) {
                console.log('\n⚠️  GARGALOS IDENTIFICADOS:');
                performanceReport.performance.bottlenecks.forEach((bottleneck, index) => {
                    console.log(`${index + 1}. ${bottleneck.description} (${bottleneck.severity})`);
                    console.log(`   Recomendação: ${bottleneck.recommendation}`);
                });
            }
        }
        
        // Desligamento automático se solicitado
        if (autoShutdown) {
            console.log('\n🔌 Iniciando desligamento automático em 30 segundos...');
            console.log('⚠️  Pressione Ctrl+C para cancelar o desligamento!');
            logger.info('Iniciando desligamento automático');
            
            // Agenda o desligamento
            powerService.scheduleShutdown(30);
            
            // Aguarda 30 segundos ou interrupção do usuário
            await new Promise(resolve => setTimeout(resolve, 30000));
        }

    } catch (error) {
        // Para a prevenção de suspensão em caso de erro
        powerService.stopPreventSleep();
        
        // Cancela o desligamento automático em caso de erro
        if (autoShutdown) {
            powerService.cancelShutdown();
            console.log('🔌 Desligamento automático cancelado devido ao erro');
        }
        
        logger.error(`Erro geral na aplicação: ${error.message}`);
        console.error(`❌ Erro inesperado: ${error.message}`);
    }
}

// Executa a aplicação
if (require.main === module) {
    main();
}

module.exports = { main };
