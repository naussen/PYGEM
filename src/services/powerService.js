// src/services/powerService.js
const { exec } = require('child_process');
const logger = require('../utils/logger');

/**
 * Serviço para gerenciamento de energia e desligamento automático
 */
class PowerService {
    constructor() {
        this.shutdownScheduled = false;
        this.preventSleepInterval = null;
    }

    /**
     * Agenda o desligamento automático do computador
     * @param {number} delayMinutes - Minutos para aguardar antes do desligamento
     */
    scheduleShutdown(delayMinutes = 5) {
        if (this.shutdownScheduled) {
            logger.warn('Desligamento já estava agendado');
            return;
        }

        this.shutdownScheduled = true;
        const delaySeconds = delayMinutes * 60;
        
        logger.info(`Desligamento automático agendado para ${delayMinutes} minutos`);
        console.log(`🔌 Desligamento automático agendado para ${delayMinutes} minutos`);
        
        // Agenda o desligamento usando o comando shutdown do Windows
        exec(`shutdown /s /t ${delaySeconds}`, (error) => {
            if (error) {
                logger.error(`Erro ao agendar desligamento: ${error.message}`);
                console.error(`❌ Erro ao agendar desligamento: ${error.message}`);
                this.shutdownScheduled = false;
            } else {
                logger.info('Desligamento agendado com sucesso');
                console.log('✅ Desligamento agendado com sucesso');
            }
        });
    }

    /**
     * Cancela o desligamento automático
     */
    cancelShutdown() {
        if (!this.shutdownScheduled) {
            return;
        }

        exec('shutdown /a', (error) => {
            if (error) {
                logger.error(`Erro ao cancelar desligamento: ${error.message}`);
                console.error(`❌ Erro ao cancelar desligamento: ${error.message}`);
            } else {
                logger.info('Desligamento cancelado');
                console.log('✅ Desligamento cancelado');
                this.shutdownScheduled = false;
            }
        });
    }

    /**
     * Impede que o computador entre em modo de suspensão
     * Executa um comando a cada 5 minutos para manter o sistema ativo
     */
    preventSleep() {
        if (this.preventSleepInterval) {
            return; // Já está ativo
        }

        logger.info('Iniciando prevenção de suspensão do sistema');
        console.log('💤 Prevenção de suspensão ativada');
        
        // Executa um comando simples a cada 5 minutos para manter o sistema ativo
        this.preventSleepInterval = setInterval(() => {
            exec('powercfg /requests', (error) => {
                if (!error) {
                    logger.debug('Sistema mantido ativo');
                }
            });
        }, 5 * 60 * 1000); // 5 minutos
    }

    /**
     * Para a prevenção de suspensão
     */
    stopPreventSleep() {
        if (this.preventSleepInterval) {
            clearInterval(this.preventSleepInterval);
            this.preventSleepInterval = null;
            logger.info('Prevenção de suspensão desativada');
            console.log('💤 Prevenção de suspensão desativada');
        }
    }

    /**
     * Obtém o status atual do serviço de energia
     */
    getStatus() {
        return {
            shutdownScheduled: this.shutdownScheduled,
            preventSleepActive: this.preventSleepInterval !== null
        };
    }

    /**
     * Limpa todos os recursos e cancela operações pendentes
     */
    cleanup() {
        this.stopPreventSleep();
        if (this.shutdownScheduled) {
            this.cancelShutdown();
        }
    }
}

// Instância singleton
const powerService = new PowerService();

// Limpa recursos quando o processo é encerrado
process.on('SIGINT', () => {
    powerService.cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    powerService.cleanup();
    process.exit(0);
});

module.exports = powerService;