const createLogger = (module) => {
    return {
        info: (message) => {
            console.log(`[INFO] ${new Date().toISOString()} [${module}]: ${message}`);
        },
        warn: (message) => {
            console.warn(`[WARN] ${new Date().toISOString()} [${module}]: ${message}`);
        },
        error: (message) => {
            console.error(`[ERROR] ${new Date().toISOString()} [${module}]: ${message}`);
        }
    };
};

// Exportar tanto o createLogger quanto o logger padrão para compatibilidade
module.exports = {
    createLogger,
    info: (message) => {
        console.log(`[INFO] ${new Date().toISOString()}: ${message}`);
    },
    warn: (message) => {
        console.warn(`[WARN] ${new Date().toISOString()}: ${message}`);
    },
    error: (message) => {
        console.error(`[ERROR] ${new Date().toISOString()}: ${message}`);
    }
};