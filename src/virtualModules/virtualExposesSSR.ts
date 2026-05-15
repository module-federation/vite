import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

/**
 * Virtual module ID for the SSR exposes map.
 * Separate from the browser exposes: no CSS injection, no document references,
 * and shared packages are imported as bare specifiers (externals in the SSR build).
 */
export function getVirtualExposesSSRId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  const scopedKey = `${options.internalName}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `virtual:mf-exposes-ssr:${scopedKey}`;
}

/**
 * Generates the SSR exposes map module.
 *
 * Differences from the browser version (virtualExposes.ts):
 * - No CSS asset injection (document APIs unavailable on Node)
 * - Shared packages (react, react-dom, etc.) must be externals in the SSR
 *   build so Node resolves them via its own module cache — this is what
 *   guarantees the React singleton is shared with react-dom/server.
 */
export function generateExposesSSR(options: NormalizedModuleFederationOptions) {
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
