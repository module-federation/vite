const MODULE_FEDERATION_LOG_PREFIX = '[Module Federation]';

export function formatModuleFederationMessage(message: string) {
  return `${MODULE_FEDERATION_LOG_PREFIX} ${message}`;
}

export function createModuleFederationError(message: string) {
  return new Error(formatModuleFederationMessage(message));
}

function toConsoleArgs(message?: unknown, rest: unknown[] = []) {
  if (typeof message === 'string') {
    return [formatModuleFederationMessage(message), ...rest];
  }

  if (message === undefined) {
    return [MODULE_FEDERATION_LOG_PREFIX, ...rest];
  }

  return [MODULE_FEDERATION_LOG_PREFIX, message, ...rest];
}

export const moduleFederationConsole = {
  log(message?: unknown, ...rest: unknown[]) {
    console.log(...toConsoleArgs(message, rest));
  },
  warn(message?: unknown, ...rest: unknown[]) {
    console.warn(...toConsoleArgs(message, rest));
  },
  error(message?: unknown, ...rest: unknown[]) {
    console.error(...toConsoleArgs(message, rest));
  },
};

export const mfLog = moduleFederationConsole.log;
export const mfWarn = moduleFederationConsole.warn;
export const mfError = moduleFederationConsole.error;
