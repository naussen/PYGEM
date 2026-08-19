const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PILOT_IDS = Object.freeze(['010', '022', '023']);

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolvePilotSources(sourceDirectory, ids = PILOT_IDS) {
    const root = path.resolve(sourceDirectory);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Diretório de fontes inexistente: ${root}`);
    }
    const selected = {};
    for (const id of ids) {
        if (!PILOT_IDS.includes(id)) throw new Error(`Piloto não autorizado: ${id}`);
        const candidates = fs.readdirSync(root)
            .filter(name => new RegExp(`^${id}(?:[_-]|$).*\\.md$`, 'i').test(name))
            .sort();
        if (candidates.length !== 1) {
            throw new Error(`Piloto ${id} deve ter exatamente uma fonte Markdown; encontradas: ${candidates.length}.`);
        }
        selected[id] = path.join(root, candidates[0]);
    }
    return selected;
}

function buildPilotRunRecord({ sourceDirectory, outputDirectory, visualPlanPath, model, seed, sources }) {
    const outputRoot = path.resolve(outputDirectory);
    if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) {
        const error = new Error(`Diretório de saída deve ser novo e vazio: ${outputRoot}`);
        error.code = 'PYGEM_PILOT_OUTPUT_NOT_NEW';
        throw error;
    }
    const planPath = path.resolve(visualPlanPath);
    if (!fs.existsSync(planPath) || !fs.statSync(planPath).isFile()) {
        throw new Error(`Plano visual inexistente: ${planPath}`);
    }
    return {
        schema_version: 1,
        status: 'preflight',
        pilot_ids: PILOT_IDS,
        source_directory: path.basename(path.resolve(sourceDirectory)),
        output_directory: path.basename(outputRoot),
        visual_plan_file: path.basename(planPath),
        visual_plan_sha256: sha256File(planPath),
        model: model || process.env.VERTEX_MODEL || process.env.GEMINI_MODEL || 'não definido',
        diversification_seed: seed || process.env.PYGEM_VISUAL_SEED || 'não definido',
        import_performed: false,
        vertex_call_performed: false,
        pilots: PILOT_IDS.map(id => ({
            pilot_id: id,
            source_file: path.basename(sources[id]),
            source_sha256: sha256File(sources[id]),
            output_file: `${id}_reescrito.md`,
            status: 'pending-human-review',
        })),
    };
}

function writePilotRunRecord(outputDirectory, record) {
    const root = path.resolve(outputDirectory);
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, '_visual-pilot-run.json');
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return target;
}

function preparePilotRun(options) {
    const ids = options.ids || PILOT_IDS;
    if (ids.join(',') !== PILOT_IDS.join(',')) {
        throw new Error(`O Pacote 9 exige exatamente os pilotos ${PILOT_IDS.join(', ')}.`);
    }
    const sources = resolvePilotSources(options.sourceDirectory, ids);
    const record = buildPilotRunRecord({ ...options, sources });
    if (options.writeRecord !== false) record.record_path = writePilotRunRecord(options.outputDirectory, record);
    return record;
}

module.exports = {
    PILOT_IDS,
    sha256File,
    resolvePilotSources,
    buildPilotRunRecord,
    writePilotRunRecord,
    preparePilotRun,
};
