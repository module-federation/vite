import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import VirtualModule from '../utils/VirtualModule';
import { getLocalSharedImportMapPath } from './virtualShared_preBuild';

export const REMOTE_ENTRY_ID = 'REMOTE_ENTRY_ID';
export function generateRemoteEntry(options: NormalizedModuleFederationOptions): string {
  const pluginImportNames = options.runtimePlugins.map((p, i) => [
    `$runtimePlugin_${i}`,
    `import $runtimePlugin_${i} from "${p}";`,
  ]);

  return `
  import {init as runtimeInit, loadRemote} from "@module-federation/runtime";
  
  ${pluginImportNames.map((item) => item[1]).join('\n')}

  const exposesMap = {
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
  import localSharedImportMap from "${getLocalSharedImportMapPath()}"
  async function init(shared = {}) {
    const initRes = runtimeInit({
      name: ${JSON.stringify(options.name)},
      remotes: [${Object.keys(options.remotes)
      .map((key) => {
        const remote = options.remotes[key];
        return `
                {
                  entryGlobalName: ${JSON.stringify(remote.entryGlobalName)},
                  name: ${JSON.stringify(remote.name)},
                  type: ${JSON.stringify(remote.type)},
                  entry: ${JSON.stringify(remote.entry)},
                }
          `;
      })
      .join(',')}
      ],
      shared: localSharedImportMap,
      plugins: [${pluginImportNames.map((item) => `${item[0]}()`).join(', ')}]
    });
    initRes.initShareScopeMap('${options.shareScope}', shared);
    return initRes
  }

  function getExposes(moduleName) {
    if (!(moduleName in exposesMap)) throw new Error(\`Module \${moduleName} does not exist in container.\`)
    return (exposesMap[moduleName])().then(res => () => res)
  }
  export {
      init,
      getExposes as get
  }
  `;
}

const wrapRemoteEntryModule = new VirtualModule("wrapRemoteEntry")
export function writeWrapRemoteEntry() {
  wrapRemoteEntryModule.writeSync(`
    import {init, get} from "${REMOTE_ENTRY_ID}"
    export {init, get}
    `)
}
export function getWrapRemoteEntryImportId() {
  return wrapRemoteEntryModule.getImportId();
}
export function getWrapRemoteEntryPath() {
  return wrapRemoteEntryModule.getPath();
}

/**
 * Inject entry file, automatically init when used as host,
 * and will not inject remoteEntry
 */
const hostAutoInitModule = new VirtualModule("hostAutoInit")
export function writeHostAutoInit() {
  hostAutoInitModule.writeSync(`
    import {init} from "${REMOTE_ENTRY_ID}"
    init()
    `)
}
export function getHostAutoInitImportId() {
  return hostAutoInitModule.getImportId();
}
export function getHostAutoInitPath() {
  return hostAutoInitModule.getPath();
}