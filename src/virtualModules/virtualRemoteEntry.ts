import {
  getLocalSharedImportMapPath_temp,
  writeLocalSharedImportMap_temp,
} from '../utils/localSharedImportMap_temp';
import {
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
  NormalizedModuleFederationOptions,
} from '../utils/normalizeModuleFederationOptions';
import VirtualModule from '../utils/VirtualModule';
import { getUsedRemotesMap } from './virtualRemotes';
import { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';
import { getPreBuildLibImportId } from './virtualShared_preBuild';

let usedShares: Set<string> = new Set();
export function getUsedShares() {
  return usedShares;
}
export function addUsedShares(pkg: string) {
  usedShares.add(pkg);
}
// *** Expose locally provided shared modules here
const localSharedImportMapModule = new VirtualModule('localSharedImportMap');
export function getLocalSharedImportMapPath() {
  return getLocalSharedImportMapPath_temp();
  // return localSharedImportMapModule.getPath()
}
let prevSharedCount: number | undefined;
export function writeLocalSharedImportMap() {
  const sharedCount = getUsedShares().size;
  if (prevSharedCount !== sharedCount) {
    prevSharedCount = sharedCount;
    writeLocalSharedImportMap_temp(generateLocalSharedImportMap());
    //   localSharedImportMapModule.writeSync(generateLocalSharedImportMap(), true)
  }
}
export function generateLocalSharedImportMap() {
  const options = getNormalizeModuleFederationOptions();
  return `
    const importMap = {
      ${Array.from(getUsedShares())
        .map(
          (pkg) => `
        ${JSON.stringify(pkg)}: async () => {
          let pkg = await import("${getPreBuildLibImportId(pkg)}")
          return pkg
        }
      `
        )
        .join(',')}
    }
      const usedShared = {
      ${Array.from(getUsedShares())
        .map((key) => {
          const shareItem = getNormalizeShareItem(key);
          return `
          ${JSON.stringify(key)}: {
            name: ${JSON.stringify(key)},
            version: ${JSON.stringify(shareItem.version)},
            scope: [${JSON.stringify(shareItem.scope)}],
            loaded: false,
            from: ${JSON.stringify(options.name)},
            async get () {
              usedShared[${JSON.stringify(key)}].loaded = true
              const {${JSON.stringify(key)}: pkgDynamicImport} = importMap 
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
      const usedRemotes = [${Object.keys(getUsedRemotesMap())
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
      ]
      export {
        usedShared,
        usedRemotes
      }
      `;
}

export const REMOTE_ENTRY_ID = 'virtual:mf-REMOTE_ENTRY_ID';
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
  import {usedShared, usedRemotes} from "${getLocalSharedImportMapPath()}"
  import {
    initResolve
  } from "${virtualRuntimeInitStatus.getImportId()}"
  async function init(shared = {}) {
    const initRes = runtimeInit({
      name: ${JSON.stringify(options.name)},
      remotes: usedRemotes,
      shared: usedShared,
      plugins: [${pluginImportNames.map((item) => `${item[0]}()`).join(', ')}],
      ${options.shareStrategy ? `shareStrategy: ${options.shareStrategy}` : ''}
    });
    initRes.initShareScopeMap('${options.shareScope}', shared);
    initResolve(initRes)
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

/**
 * Inject entry file, automatically init when used as host,
 * and will not inject remoteEntry
 */
const hostAutoInitModule = new VirtualModule('hostAutoInit');
export function writeHostAutoInit() {
  hostAutoInitModule.writeSync(`
    import {init} from "${REMOTE_ENTRY_ID}"
    init()
    `);
}
export function getHostAutoInitImportId() {
  return hostAutoInitModule.getImportId();
}
export function getHostAutoInitPath() {
  return hostAutoInitModule.getPath();
}
