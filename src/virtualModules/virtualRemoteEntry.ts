import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getLocalSharedImportMapId } from './virtualShared_preBuild';
const emptyPath = require.resolve('an-empty-js-file');

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
  import localSharedImportMap from "${getLocalSharedImportMapId()}"
  async function init(shared = {}) {
    const localShared = {
      ${Object.keys(options.shared)
        .map((key) => {
          const shareItem = options.shared[key];
          return `
          ${JSON.stringify(key)}: {
            name: ${JSON.stringify(shareItem.name)},
            version: ${JSON.stringify(shareItem.version)},
            scope: [${JSON.stringify(shareItem.scope)}],
            loaded: false,
            from: ${JSON.stringify(options.name)},
            async get () {
              localShared[${JSON.stringify(key)}].loaded = true
              const {${JSON.stringify(key)}: pkgDynamicImport} = localSharedImportMap 
              const res = await pkgDynamicImport()
              const exportModule = {...res}
              // All npm packages pre-built by vite will be converted to esm
              Object.defineProperty(exportModule, "__esModule", {
                value: true,
                enumerable: false
              })
              return function () {
                return exportModule
              }
            },
            shareConfig: {
              singleton: ${shareItem.shareConfig.singleton},
              requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)}
            }
          }
        `;
        })
        .join(',')}
    }
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
      shared: localShared,
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

export const WRAP_REMOTE_ENTRY_QUERY_STR = '__mf__wrapRemoteEntry__';
export const WRAP_REMOTE_ENTRY_PATH = emptyPath + '?' + WRAP_REMOTE_ENTRY_QUERY_STR;
export function generateWrapRemoteEntry(): string {
  return `
  import {init, get} from "${REMOTE_ENTRY_ID}"
  export {init, get}
  `;
}

/**
 * Inject entry file, automatically init when used as host,
 * and will not inject remoteEntry
 */
export const HOST_AUTO_INIT_QUERY_STR = '__mf__isHostInit';
export const HOST_AUTO_INIT_PATH = emptyPath + '?' + HOST_AUTO_INIT_QUERY_STR;
export function generateWrapHostInit(): string {
  return `
    import {init} from "${REMOTE_ENTRY_ID}"
    init()
    `;
}
