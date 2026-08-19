const {
    PILOT_IDS,
    preparePilotRun,
} = require('./visualPilotRunner');

function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`Argumento inesperado: ${token}`);
        const [rawKey, inlineValue] = token.slice(2).split('=', 2);
        if (rawKey === 'help') return { help: true };
        const value = inlineValue ?? argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`Valor ausente para --${rawKey}`);
        values[rawKey] = value;
    }
    return values;
}

function usage() {
    return [
        'Uso:',
        '  npm run visual:pilots:preflight -- --source-dir <dir> --plan <arquivo> --output-dir <dir>',
        '',
        `O comando aceita somente os pilotos ${PILOT_IDS.join(', ')} e não chama o Vertex AI.`,
        'A saída deve ser um diretório novo; o registro será _visual-pilot-run.json.',
    ].join('\n');
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help) {
        console.log(usage());
        return 0;
    }
    const required = [
        ['source-dir', 'sourceDirectory'],
        ['plan', 'visualPlanPath'],
        ['output-dir', 'outputDirectory'],
    ];
    const options = {};
    required.forEach(([key, name]) => {
        if (!args[key]) throw new Error(`Informe --${key}.\n\n${usage()}`);
        options[name] = args[key];
    });
    options.model = args.model;
    options.seed = args.seed;
    const record = preparePilotRun(options);
    console.log(`Preflight concluído: ${record.record_path}`);
    console.log(`Pilotos: ${record.pilot_ids.join(', ')} | Vertex AI: não chamado | Importação: não realizada`);
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(`Erro no preflight: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { parseArgs, usage, main };
