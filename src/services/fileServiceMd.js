const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { assertValidGeneratedContent } = require('../utils/validation');

const readMdFiles = (directory) => {
    try {
        const files = fs.readdirSync(directory);
        const mdFiles = files
            .filter(file => path.extname(file).toLowerCase() === '.md')
            .map(file => path.join(directory, file));
        
        logger.info(`Encontrados ${mdFiles.length} arquivos .md em ${directory}`);
        return mdFiles;
    } catch (error) {
        logger.error(`Erro ao ler diretório ${directory}: ${error.message}`);
        throw new Error(`Não foi possível ler o diretório: ${error.message}`);
    }
};

const getAllSubdirectories = (directory) => {
    try {
        const result = [];
        const items = fs.readdirSync(directory, { withFileTypes: true });
        
        // Adiciona o diretório principal
        result.push(directory);
        
        // Adiciona todas as subpastas
        for (const item of items) {
            if (item.isDirectory()) {
                const subdirPath = path.join(directory, item.name);
                result.push(subdirPath);
                
                // Busca recursivamente em subpastas mais profundas
                const subdirs = getAllSubdirectories(subdirPath);
                result.push(...subdirs.slice(1)); // Ignora o primeiro que já foi adicionado
            }
        }
        
        logger.info(`Encontrados ${result.length} diretórios em ${directory}`);
        return result;
    } catch (error) {
        logger.error(`Erro ao ler subdiretórios de ${directory}: ${error.message}`);
        throw new Error(`Não foi possível ler os subdiretórios: ${error.message}`);
    }
};

const readAllMdFilesInSubdirectories = (directory) => {
    try {
        const allDirs = getAllSubdirectories(directory);
        const result = [];
        
        for (const dir of allDirs) {
            const mdFiles = readMdFiles(dir);
            if (mdFiles.length > 0) {
                result.push({
                    directory: dir,
                    files: mdFiles
                });
            }
        }
        
        logger.info(`Encontrados arquivos .md em ${result.length} diretórios`);
        return result;
    } catch (error) {
        logger.error(`Erro ao ler arquivos .md em subdiretórios: ${error.message}`);
        throw new Error(`Não foi possível ler os arquivos .md em subdiretórios: ${error.message}`);
    }
};

/**
 * Escreve o conteúdo reescrito em um novo arquivo ou substitui o original
 * @param {string} outputDirectory - Diretório de saída
 * @param {string} originalFilePath - Caminho completo do arquivo original
 * @param {string} content - Conteúdo reescrito
 * @param {boolean} replaceOriginal - Se deve substituir o arquivo original
 * @param {boolean} deleteOriginal - Se deve excluir o arquivo original após criar o novo
 * @returns {string} - Caminho do arquivo criado/modificado
 */
const writeRewrittenContent = (outputDirectory, originalFilePath, content, replaceOriginal = false, deleteOriginal = false) => {
    try {
        assertValidGeneratedContent(content);
        const originalFileName = path.basename(originalFilePath);
        const nameWithoutExt = path.parse(originalFileName).name;
        let outputFilePath;
        
        if (replaceOriginal) {
            // Substitui o arquivo original
            outputFilePath = originalFilePath;
            logger.info(`Substituindo arquivo original: ${originalFilePath}`);
        } else {
            // Cria um novo arquivo com sufixo
            const newFileName = `${nameWithoutExt}_reescrito.md`;
            outputFilePath = path.join(outputDirectory, newFileName);
            logger.info(`Criando novo arquivo: ${outputFilePath}`);
            
            // Se solicitado, exclui o arquivo original após criar o novo
            if (deleteOriginal && fs.existsSync(originalFilePath)) {
                logger.info(`Excluindo arquivo original: ${originalFilePath}`);
                fs.unlinkSync(originalFilePath);
            }
        }
        
        fs.writeFileSync(outputFilePath, content, 'utf8');
        logger.info(`Arquivo salvo: ${outputFilePath}`);
        
        return outputFilePath;
    } catch (error) {
        logger.error(`Erro ao salvar arquivo ${originalFilePath}: ${error.message}`);
        throw new Error(`Não foi possível salvar o arquivo: ${error.message}`);
    }
};

const appendRewrittenContent = (outputDirectory, originalFileName, content, isFirstBlock = false) => {
    try {
        assertValidGeneratedContent(content);
        // Remove extensão e adiciona prefixo
        const nameWithoutExt = path.parse(originalFileName).name;
        const newFileName = `${nameWithoutExt}_reescrito.md`;
        const outputFilePath = path.join(outputDirectory, newFileName);
        
        if (isFirstBlock) {
            // Se é o primeiro bloco, sobrescreve o arquivo
            fs.writeFileSync(outputFilePath, content, 'utf8');
            logger.info(`Arquivo iniciado: ${outputFilePath}`);
        } else {
            // Se não é o primeiro bloco, adiciona ao final
            fs.appendFileSync(outputFilePath, content, 'utf8');
            logger.info(`Conteúdo adicionado ao arquivo: ${outputFilePath}`);
        }
        
        return outputFilePath;
    } catch (error) {
        logger.error(`Erro ao salvar/adicionar conteúdo ao arquivo ${originalFileName}: ${error.message}`);
        throw new Error(`Não foi possível salvar/adicionar ao arquivo: ${error.message}`);
    }
};

const appendToSubdirectoryFile = (outputDirectory, subdirectoryPath, originalFileName, content, isFirstFile = false) => {
    try {
        assertValidGeneratedContent(content);
        // Cria um nome de arquivo baseado no nome da subpasta
        const subdirName = path.basename(subdirectoryPath);
        const newFileName = `${subdirName}_reescrito.md`;
        const outputFilePath = path.join(outputDirectory, newFileName);
        
        // Adiciona uma quebra de linha entre conteúdos, sem incluir o nome do arquivo
        const contentWithSeparator = isFirstFile ? content : `\n\n${content}`;
        
        if (isFirstFile) {
            // Se é o primeiro arquivo, sobrescreve o arquivo de saída
            fs.writeFileSync(outputFilePath, contentWithSeparator, 'utf8');
            logger.info(`Arquivo de subpasta iniciado: ${outputFilePath}`);
        } else {
            // Se não é o primeiro arquivo, adiciona ao final
            fs.appendFileSync(outputFilePath, contentWithSeparator, 'utf8');
            logger.info(`Conteúdo adicionado ao arquivo de subpasta: ${outputFilePath}`);
        }
        
        return outputFilePath;
    } catch (error) {
        logger.error(`Erro ao salvar/adicionar conteúdo ao arquivo de subpasta para ${subdirectoryPath}: ${error.message}`);
        throw new Error(`Não foi possível salvar/adicionar ao arquivo de subpasta: ${error.message}`);
    }
};

const createOutputDirectory = (outputDirectory) => {
    try {
        logger.info(`Verificando diretório de saída: ${outputDirectory}`);
        
        // Verifica se existe algo com esse nome
        if (fs.existsSync(outputDirectory)) {
            const stats = fs.statSync(outputDirectory);
            if (!stats.isDirectory()) {
                // Se existir um arquivo com esse nome, remove
                logger.info(`Removendo arquivo existente: ${outputDirectory}`);
                fs.unlinkSync(outputDirectory);
            } else {
                logger.info(`Diretório de saída já existe: ${outputDirectory}`);
                return; // Diretório já existe e é válido
            }
        }
        
        // Cria o diretório (incluindo diretórios pais se necessário)
        fs.mkdirSync(outputDirectory, { recursive: true });
        logger.info(`Diretório de saída criado: ${outputDirectory}`);
        
        // Verifica se foi criado com sucesso
        if (!fs.existsSync(outputDirectory) || !fs.statSync(outputDirectory).isDirectory()) {
            throw new Error(`Falha ao criar o diretório: ${outputDirectory}`);
        }
        
    } catch (error) {
        logger.error(`Erro ao criar diretório ${outputDirectory}: ${error.message}`);
        throw new Error(`Não foi possível criar o diretório de saída: ${error.message}`);
    }
};

const getFileStats = (filePath) => {
    try {
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        
        return {
            size: stats.size,
            sizeKB: Math.round(stats.size / 1024 * 100) / 100,
            wordCount: content.split(/\s+/).filter(word => word.length > 0).length,
            charCount: content.length,
            lineCount: content.split('\n').length
        };
    } catch (error) {
        logger.error(`Erro ao obter estatísticas do arquivo ${filePath}: ${error.message}`);
        return null;
    }
};

module.exports = {
    readMdFiles,
    writeRewrittenContent,
    appendRewrittenContent,
    createOutputDirectory,
    getFileStats,
    getAllSubdirectories,
    readAllMdFilesInSubdirectories,
    appendToSubdirectoryFile
};
