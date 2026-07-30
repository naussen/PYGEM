const assert = require('assert');
const { validateMermaidBlocks } = require('./src/utils/validation');

const fence = '```';

function mermaid(code) {
    return `${fence}mermaid\n${code}\n${fence}`;
}

assert.strictEqual(validateMermaidBlocks('Texto sem diagrama.').valid, true);
assert.strictEqual(
    validateMermaidBlocks(mermaid('flowchart TD\n  A[Origem] --> B[Destino]')).valid,
    true
);
assert.strictEqual(
    validateMermaidBlocks(mermaid('flowchart TD\n  A[Origem] -->|segue|\n  B[Destino]')).valid,
    false
);
assert.strictEqual(
    validateMermaidBlocks(mermaid('flowchart TD\\n  A[Origem] --> B[Destino]')).valid,
    false
);
assert.strictEqual(
    validateMermaidBlocks(`${fence}mermaid\nflowchart TD\n  A[Origem]`).valid,
    false
);
assert.strictEqual(
    validateMermaidBlocks(`${fence} mermaid\nflowchart TD\n  A[Origem] --> B[Destino]\n${fence}`).valid,
    false
);

console.log('Testes de validação Mermaid do PYGEM: OK');
