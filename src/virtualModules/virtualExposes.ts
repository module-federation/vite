import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

export function getVirtualExposesId(
  options: Pick<NormalizedModuleFederationOptions, 'name' | 'filename'>
) {
  const scopedKey = `${options.name}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `virtual:mf-exposes:${scopedKey}`;
}

export function generateExposes(options: NormalizedModuleFederationOptions, command?: string) {
  return `
    export default {
    ${Object.keys(options.exposes)
      .map((key) => {
        const importPath = JSON.stringify(options.exposes[key].import);
        // In dev mode, append a timestamp to bust the browser's ESM module cache.
        // Without this, import() returns the cached (stale) module even after
        // the remote's Vite dev server has processed the HMR update.
        const importExpr =
          command === 'serve'
            ? `/* @vite-ignore */ ${importPath} + "?t=" + Date.now()`
            : importPath;
        return `
        ${JSON.stringify(key)}: async () => {
          const importModule = await import(${importExpr})
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
