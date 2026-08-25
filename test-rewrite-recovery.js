const assert = require('assert');
const config = require('./src/config/runtime');
const { estimateTokens } = require('./src/services/tokenService');
const { diagnostics } = require('./src/services/geminiService');

function response(text, finishReason = 'STOP') {
    return {
        text,
        finishReason,
        usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: estimateTokens(text),
            totalTokenCount: 100 + estimateTokens(text),
        },
    };
}

async function run() {
    const source = [
        '## Primeiro tema',
        ...Array.from({ length: 35 }, () => 'Conteúdo completo do primeiro tema, com uma informação juridicamente relevante.'),
        '## Segundo tema',
        ...Array.from({ length: 35 }, () => 'Conteúdo completo do segundo tema, com outra informação juridicamente relevante.'),
    ].join('\n');
    assert.ok(estimateTokens(source) > config.processing.minRecoveryBlockTokens * 2);

    const calls = [];
    const models = [];
    const maxTokensByUnit = new Map();
    const executor = async (_model, _modelName, _overrides, _prompt, context) => {
        context.budget.consume();
        calls.push(context.workUnitId);
        models.push(_modelName);
        maxTokensByUnit.set(context.workUnitId, context.maxOutputTokens);
        if (context.workUnitId === 'b001') {
            return response('Resposta truncada', 'MAX_TOKENS');
        }
        return response(context.sourceContent);
    };
    const budget = diagnostics.createRequestBudget('bloco simulado', 5);
    const rewritten = await diagnostics.rewriteBlockWithRecovery(
        source,
        'Reescreva com fidelidade.',
        'bloco simulado',
        {
            budget,
            workUnitId: 'b001',
            basePrompt: 'Reescreva com fidelidade.',
            generationExecutor: executor,
        }
    );

    assert.strictEqual(
        rewritten.replace(/\s+/g, ' ').trim(),
        source.replace(/\s+/g, ' ').trim()
    );
    assert.strictEqual(calls[0], 'b001');
    assert.strictEqual(models[0], config.model);
    assert.strictEqual(models[1], config.fallbackModel);
    assert.ok(calls.length >= 3 && calls.length <= 5);
    assert.strictEqual(budget.used, calls.length);
    assert.ok(calls.slice(2).every(unitId => unitId.startsWith('b001.')));
    assert.ok(
        [...maxTokensByUnit.values()].every(value => (
            value <= config.outputPolicy.maxOutputTokensPerRequest
        ))
    );

    let shortAttempt = 0;
    const retryBudget = diagnostics.createRequestBudget('correção simulada', 2);
    const corrected = await diagnostics.generateValidatedRewrite(
        '## Tema\n\nConteúdo integral que deve permanecer na resposta reescrita.',
        'Reescreva.',
        {
            budget: retryBudget,
            workUnitId: 'retry',
            validationRetryDelaySeconds: 0,
            generationExecutor: async (_model, _name, _overrides, _prompt, context) => {
                context.budget.consume();
                shortAttempt++;
                return shortAttempt === 1
                    ? response('curto')
                    : response(context.sourceContent);
            },
        }
    );
    assert.match(corrected, /Conteúdo integral/u);
    assert.strictEqual(shortAttempt, 2);
    assert.strictEqual(retryBudget.used, 2);

    const tinySource = '## Tema mínimo\n\nConteúdo integral de um fragmento pequeno.';
    const tinyModels = [];
    const tinyBudget = diagnostics.createRequestBudget('folha mínima simulada', 3);
    const defaultRecoveryModel = config.recoveryModel;
    const recoveryModelFixture = 'gemini-recovery-fixture';
    config.recoveryModel = recoveryModelFixture;
    try {
        const recoveredByModernModel = await diagnostics.rewriteBlockWithRecovery(
            tinySource,
            'Reescreva com fidelidade.',
            'folha mínima simulada',
            {
                budget: tinyBudget,
                workUnitId: 'leaf',
                basePrompt: 'Reescreva com fidelidade.',
                generationExecutor: async (_model, modelName, _overrides, _prompt, context) => {
                    context.budget.consume();
                    tinyModels.push(modelName);
                    return modelName === recoveryModelFixture
                        ? response(context.sourceContent)
                        : response('Resposta truncada', 'MAX_TOKENS');
                },
            }
        );
        assert.strictEqual(recoveredByModernModel, tinySource);
        assert.deepStrictEqual(tinyModels, [
            config.model,
            config.fallbackModel,
            recoveryModelFixture,
        ]);
        assert.strictEqual(tinyBudget.used, 3);
    } finally {
        config.recoveryModel = defaultRecoveryModel;
    }

    console.log('Testes simulados de recuperação e orçamento do PYGEM: OK');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
