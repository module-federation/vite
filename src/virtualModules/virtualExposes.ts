import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

export function getVirtualExposesId(
  options: Pick<NormalizedModuleFederationOptions, 'name' | 'filename'>
) {
  const scopedKey = `${options.name}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `virtual:mf-exposes:${scopedKey}`;
}

export function generateExposes(options: NormalizedModuleFederationOptions, command = 'build') {
  if (command === 'serve') {
    const entries = Object.entries(options.exposes);
    const syncHelper = `
    function __mfSyncExpose(target, source) {
      for (const key of Object.keys(target)) {
        delete target[key]
      }
      Object.assign(target, source)
      Object.defineProperty(target, "__esModule", {
        value: true,
        enumerable: false
      })
    }`;
    const stateLines = entries
      .map(
        ([, value], index) => `
    const __mfExport_${index} = {}
    let __mfLoaded_${index} = false
    async function __mfLoadExpose_${index}() {
      const exposeModule = await import(${JSON.stringify(value.import)})
      __mfLoaded_${index} = true
      __mfSyncExpose(__mfExport_${index}, exposeModule)
      return __mfExport_${index}
    }`
      )
      .join('');
    const exposeEntries = entries
      .map(
        ([key], index) => `
        ${JSON.stringify(key)}: () => __mfLoadExpose_${index}()`
      )
      .join(',');
    const hmrExports = entries
      .map(
        ([key], index) => `
      ${JSON.stringify(key)}: __mfExport_${index}`
      )
      .join(',');
    const hmrAccept = entries
      .map(
        ([key], index) => `
        const nextExpose_${index} = modules[${index}]
        if (__mfLoaded_${index} && nextExpose_${index}) {
          __mfSyncExpose(__mfExport_${index}, nextExpose_${index})
        }`
      )
      .join('\n');
    const hmrDeps = entries.map(([, value]) => JSON.stringify(value.import)).join(', ');

    return `
    ${syncHelper}
    ${stateLines}
    export const __mfHmrExports = {
    ${hmrExports}
  }
    export default {
    ${exposeEntries}
  }
    if (import.meta.hot) {
      import.meta.hot.accept([${hmrDeps}], (modules) => {
${hmrAccept}
      })
    }
  `;
  }

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
