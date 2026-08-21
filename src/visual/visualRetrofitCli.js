require('dotenv').config();

const readline = require('readline-sync');
const geminiService = require('../services/geminiService');
const { runVisualRetrofit } = require('./visualRetrofitService');

const OPTION_NAMES = new Set([
    'input-dir',
    'visual-dir',
    'output-dir',
    'discipline',
    'dry-run',
]);

function stripWrappingQuotes(value) {
    const trimmed = String(value || '').trim();
    if (trimmed.length >= 2 && ['"', "'"].includes(trimmed[0]) && trimmed.at(-1) === trimmed[0]) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function parseArgs(argv = process.argv.slice(2)) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index] || '');
        if (!argument.startsWith('--')) continue;
        const [name, inlineValue] = argument.slice(2).split('=', 2);
        if (!OPTION_NAMES.has(name)) throw new Error(`Opção desconhecida: --${name}`);
        if (name === 'dry-run') {
            values.set(name, true);
            continue;
        }
        const value = inlineValue ?? argv[index + 1];
        if (value == null || (inlineValue == null && String(value).startsWith('--'))) {
            throw new Error(`A opção --${name} exige um valor.`);
        }
        values.set(name, stripWrappingQuotes(value));
        if (inlineValue == null) index += 1;
    }
    return {
        inputDirectory: values.get('input-dir') || null,
        visualDirectory: values.get('visual-dir') || null,
        outputDirectory: values.get('output-dir') || null,
        discipline: values.get('discipline') || null,
        dryRun: values.get('dry-run') === true,
    };
}

function promptMissingOptions(options, question = prompt => readline.question(prompt)) {
    return {
        ...options,
        inputDirectory: options.inputDirectory || stripWrappingQuotes(question(
            '[ENTRADA] Pasta dos arquivos já reescritos: '
        )),
        visualDirectory: options.visualDirectory || stripWrappingQuotes(question(
            '[VISUAL] Pasta dos mapas visuais: '
        )),
        outputDirectory: options.outputDirectory || stripWrappingQuotes(question(
            '[SAÍDA] Pasta nova para os arquivos adaptados: '
        )),
        discipline: options.discipline || String(question('[DISCIPLINA] Disciplina: ') || '').trim(),
    };
}

async function main(argv = process.argv.slice(2)) {
    let options = parseArgs(argv);
    if (process.stdin.isTTY) options = promptMissingOptions(options);
    if (!options.inputDirectory || !options.visualDirectory || !options.outputDirectory || !options.discipline) {
        throw new Error(
            'Informe --input-dir, --visual-dir, --output-dir e --discipline.'
        );
    }

    console.log('PYGEM - Retrofit visual incremental');
    console.log('Os arquivos de entrada nunca serão sobrescritos.');
    const preflight = await runVisualRetrofit({ ...options, dryRun: true });
    const mismatchCount = preflight.pairing.title_mismatches.length;
    if (mismatchCount > 0) {
        console.log(`PREFLIGHT: ${mismatchCount} mapa(s) têm título incompatível com o arquivo pareado.`);
        preflight.pairing.title_mismatches.forEach(item => {
            console.log(
                `  - ${item.file}: fonte="${item.source_title || 'sem título'}"; `
                + `mapa="${item.visual_topics.join(' | ')}"`
            );
        });
    }
    if (options.dryRun) {
        console.log('DRY-RUN: nenhuma chamada Vertex e nenhuma gravação foram realizadas.');
        console.log('Resumo:', JSON.stringify(preflight.summary));
        return preflight;
    }
    if (mismatchCount > 0) {
        throw new Error('Corrija as associações indicadas pelo dry-run antes de usar o Vertex AI.');
    }
    if (!options.dryRun) {
        const connection = await geminiService.testConnection();
        if (!connection.success) throw new Error(connection.error);
    }

    const report = await runVisualRetrofit(options);
    console.log('Resumo:', JSON.stringify(report.summary));
    if (!options.dryRun) {
        console.log(`Relatório salvo em: ${options.outputDirectory}\\_visual-retrofit-report.json`);
    }
    return report;
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Erro no retrofit visual: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs, promptMissingOptions, main };
