require('dotenv').config();

const AppMd = require('./app-md');

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                    🐍 PYGEM - Reescrita Didática                 ║');
    console.log('║               Reescrita de Markdown com Vertex AI               ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log('');

    await AppMd.main();
}

if (require.main === module) {
    main().catch((error) => {
        console.error('❌ Erro fatal:', error.message);
        process.exit(1);
    });
}

module.exports = { main };
