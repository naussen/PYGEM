const fs = require('fs');
const path = require('path');
const { MAX_VISUAL_GUIDE_BYTES, compileVisualGuide } = require('./visualGuideCompiler');

function parseArgs(argv) {
    const result = {
        inputPath: null,
        outputPath: null,
        discipline: null,
        guideId: null,
        diversificationSeed: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--') && !result.inputPath) {
            result.inputPath = argument;
            continue;
        }
        const [rawKey, inlineValue] = argument.split('=', 2);
        const key = rawKey.replace(/^--/, '');
        const value = inlineValue ?? argv[index + 1];
        if (!inlineValue && value && !value.startsWith('--')) index += 1;
        if (key === 'output') result.outputPath = value;
        else if (key === 'discipline') result.discipline = value;
        else if (key === 'guide-id') result.guideId = value;
        else if (key === 'seed') result.diversificationSeed = value;
        else {
            const error = new Error(`Argumento desconhecido: ${argument}`);
            error.code = 'PYGEM_VISUAL_CLI_ARGUMENT_INVALID';
            throw error;
        }
    }
    return result;
}

function writeJsonAtomic(filePath, value) {
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

function getDefaultOutputPath(inputPath) {
    const parsed = path.parse(inputPath);
    const stem = parsed.name.replace(/\.visual$/i, '');
    return path.join(parsed.dir, `${stem}.visual-plan.json`);
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (!args.inputPath || !args.discipline) {
        const error = new Error(
            'Uso: npm.cmd run visual:compile -- relatorio.visual.md --discipline "Disciplina"'
        );
        error.code = 'PYGEM_VISUAL_CLI_REQUIRED_ARGUMENT';
        throw error;
    }

    const inputPath = path.resolve(args.inputPath);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        const error = new Error(`Relatório visual não encontrado: ${inputPath}`);
        error.code = 'PYGEM_VISUAL_GUIDE_NOT_FOUND';
        throw error;
    }
    if (fs.statSync(inputPath).size > MAX_VISUAL_GUIDE_BYTES) {
        const error = new Error(`Relatório visual excede ${MAX_VISUAL_GUIDE_BYTES} bytes.`);
        error.code = 'PYGEM_VISUAL_GUIDE_TOO_LARGE';
        throw error;
    }

    const markdown = fs.readFileSync(inputPath, 'utf8');
    const plan = compileVisualGuide(markdown, {
        discipline: args.discipline,
        guideId: args.guideId,
        diversificationSeed: args.diversificationSeed,
    });
    const outputPath = path.resolve(args.outputPath || getDefaultOutputPath(inputPath));
    writeJsonAtomic(outputPath, plan);
    console.log(`Plano visual validado e salvo: ${outputPath}`);
    return { outputPath, plan };
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Falha ao compilar relatório visual: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    parseArgs,
    getDefaultOutputPath,
    writeJsonAtomic,
    main,
};
