const useOptimizedConfig = process.env.USE_OPTIMIZED_CONFIG === 'true'
    || process.argv.includes('--optimized');

module.exports = useOptimizedConfig
    ? require('./gemini-optimized')
    : require('./gemini');
