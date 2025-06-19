import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

export const VIRTUAL_EXPOSES = 'virtual:mf-exposes';
export function generateExposes() {
  const options = getNormalizeModuleFederationOptions();
  return `
    const GLOBAL_KEY = '__MF_SINGLETONS__';
    const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;
    globalObj[GLOBAL_KEY] = globalObj[GLOBAL_KEY] || {};

    export default {
    ${Object.keys(options.exposes)
      .map((key) => {
        const singletonKey = JSON.stringify(key);
        return `
        ${singletonKey}: async () => {
          if (!globalObj[GLOBAL_KEY][${singletonKey}]) {
            const importModule = await import(${JSON.stringify(options.exposes[key].import)});
            const exportModule = {};
            Object.assign(exportModule, importModule);
            Object.defineProperty(exportModule, "__esModule", {
              value: true,
              enumerable: false
            });
            globalObj[GLOBAL_KEY][${singletonKey}] = exportModule;
          }
          return globalObj[GLOBAL_KEY][${singletonKey}];
        }
      `;
      })
      .join(',')}
    }
  `;
}
