import { Logger } from 'vite';

const LOG_PREFIX = '[module-federation]';

export interface MfLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export function createMfLogger(logger: Logger): MfLogger {
  return {
    info: (msg: string) => logger.info(`${LOG_PREFIX} ${msg}`, { timestamp: true }),
    warn: (msg: string) => logger.warn(`${LOG_PREFIX} ${msg}`, { timestamp: true }),
  };
}
