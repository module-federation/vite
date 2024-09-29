import { getNormalizeModuleFederationOptions } from "../utils/normalizeModuleFederationOptions";

export const VIRTUAL_EXPOSES = 'virtual:mf-exposes';
export function generateExposes() {
  const options = getNormalizeModuleFederationOptions()
  return `
    export default {
    ${Object.keys(options.exposes)
      .map((key) => {
        return `
        ${JSON.stringify(key)}: async () => {
          const importModule = await import(${JSON.stringify(options.exposes[key].import)})
          const exportModule = {}
          Object.assign(exportModule, importModule)
          Object.defineProperty(exportModule, "__esModule", {
            value: true,
            enumerable: false
          })
          return exportModule
        }
      `;
      })
      .join(',')}
  }
  `;
}
