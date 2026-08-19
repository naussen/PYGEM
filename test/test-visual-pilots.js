const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    PILOT_IDS,
    preparePilotRun,
} = require('../src/visual/visualPilotRunner');
const { parseArgs } = require('../src/visual/runVisualPilotsCli');

assert.deepStrictEqual(
    parseArgs(['--source-dir', 'fontes', '--plan', 'plano.json', '--output-dir', 'saida']),
    { 'source-dir': 'fontes', plan: 'plano.json', 'output-dir': 'saida' }
);

const fixtures = path.join(__dirname, 'fixtures', 'visual');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pygem-visual-pilots-'));
const sourceDirectory = path.join(temporaryRoot, 'fontes');
const outputDirectory = path.join(temporaryRoot, 'saida');
fs.mkdirSync(sourceDirectory, { recursive: true });
PILOT_IDS.forEach(id => fs.copyFileSync(
    path.join(fixtures, `${id}-source.md`),
    path.join(sourceDirectory, `${id}_piloto.md`)
));
const planPath = path.join(sourceDirectory, 'visual-plan.json');
fs.copyFileSync(path.join(fixtures, 'visual-plan.valid.json'), planPath);

try {
    const record = preparePilotRun({
        sourceDirectory,
        outputDirectory,
        visualPlanPath: planPath,
        model: 'fixture-model',
        seed: 'fixture-seed',
    });
    assert.deepStrictEqual(record.pilot_ids, PILOT_IDS);
    assert.strictEqual(record.vertex_call_performed, false);
    assert.strictEqual(record.import_performed, false);
    assert(fs.existsSync(path.join(outputDirectory, '_visual-pilot-run.json')));
    assert.throws(
        () => preparePilotRun({
            sourceDirectory,
            outputDirectory,
            visualPlanPath: planPath,
            ids: ['010', '022'],
        }),
        /exige exatamente/u
    );
    console.log('test-visual-pilots: ok');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
