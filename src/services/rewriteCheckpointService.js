const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHECKPOINT_VERSION = 1;

function hash(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function sanitizeFileName(fileName) {
    return path.basename(String(fileName || 'arquivo'))
        .replace(/[^\p{L}\p{N}._-]+/gu, '_')
        .slice(0, 80);
}

function writeJsonAtomic(filePath, value) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function createRewriteCheckpoint({
    content,
    prompt,
    fileName,
    blocks,
    model,
    blockInputTokens,
    generationSignature = null,
    directory = path.join(__dirname, '../../logs/checkpoints'),
}) {
    const fingerprint = hash(JSON.stringify({
        contentHash: hash(content),
        promptHash: hash(prompt),
        model,
        blockInputTokens,
        generationSignature,
        totalBlocks: blocks.length,
    }));
    const filePath = path.join(
        directory,
        `${sanitizeFileName(fileName)}-${fingerprint.slice(0, 16)}.json`
    );
    const sourceHashes = blocks.map(block => hash(block));
    let state = {
        version: CHECKPOINT_VERSION,
        fingerprint,
        fileName: path.basename(String(fileName || 'arquivo')),
        model,
        totalBlocks: blocks.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedBlocks: {},
    };

    if (fs.existsSync(filePath)) {
        try {
            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (
                saved.version === CHECKPOINT_VERSION
                && saved.fingerprint === fingerprint
                && saved.totalBlocks === blocks.length
            ) {
                state = saved;
            }
        } catch {
            // Um checkpoint corrompido e ignorado; a proxima gravacao atomica o substitui.
        }
    }

    return {
        filePath,

        get(blockNumber) {
            const entry = state.completedBlocks[String(blockNumber)];
            if (!entry || entry.sourceHash !== sourceHashes[blockNumber - 1]) return null;
            return typeof entry.output === 'string' && entry.output.trim()
                ? entry.output
                : null;
        },

        save(blockNumber, output) {
            state.completedBlocks[String(blockNumber)] = {
                sourceHash: sourceHashes[blockNumber - 1],
                output,
                completedAt: new Date().toISOString(),
            };
            state.updatedAt = new Date().toISOString();
            writeJsonAtomic(filePath, state);
        },

        count() {
            return Object.keys(state.completedBlocks).length;
        },

        clear() {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        },
    };
}

module.exports = {
    createRewriteCheckpoint,
    diagnostics: {
        hash,
        sanitizeFileName,
    },
};
