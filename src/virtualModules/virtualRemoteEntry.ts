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
import { VIRTUAL_EXPOSES } from './virtualExposes';
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
          if (!shareItem) return null;
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
        .filter((x) => x !== null)
        .join(',')}
    }
      const usedRemotes = [${Object.keys(getUsedRemotesMap())
        .map((key) => {
          const remote = options.remotes[key];
          if (!remote) return null;
          return `
                {
                  entryGlobalName: ${JSON.stringify(remote.entryGlobalName)},
                  name: ${JSON.stringify(remote.name)},
                  type: ${JSON.stringify(remote.type)},
                  entry: ${JSON.stringify(remote.entry)},
                }
          `;
        })
        .filter((x) => x !== null)
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
  import exposesMap from "${VIRTUAL_EXPOSES}"
  import {usedShared, usedRemotes} from "${getLocalSharedImportMapPath()}"
  import {
    initResolve
  } from "${virtualRuntimeInitStatus.getImportId()}"
  const initTokens = {}
  const shareScopeName = ${JSON.stringify(options.shareScope)}
  const mfName = ${JSON.stringify(options.name)}
  async function init(shared = {}, initScope = []) {
    const initRes = runtimeInit({
      name: mfName,
      remotes: usedRemotes,
      shared: usedShared,
      plugins: [${pluginImportNames.map((item) => `${item[0]}()`).join(', ')}],
      ${options.shareStrategy ? `shareStrategy: '${options.shareStrategy}'` : ''}
    });
    // handling circular init calls
    var initToken = initTokens[shareScopeName];
    if (!initToken)
      initToken = initTokens[shareScopeName] = { from: mfName };
    if (initScope.indexOf(initToken) >= 0) return;
    initScope.push(initToken);
    initRes.initShareScopeMap('${options.shareScope}', shared);
    try {
      await Promise.all(await initRes.initializeSharing('${options.shareScope}', {
        strategy: '${options.shareStrategy}',
        from: "build",
        initScope
      }));
    } catch (e) {
      console.error(e)
    }
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
export const HOST_AUTO_INIT_TAG = '__H_A_I__';
const hostAutoInitModule = new VirtualModule('hostAutoInit', HOST_AUTO_INIT_TAG);
export function writeHostAutoInit() {
  hostAutoInitModule.writeSync(`
    const remoteEntryPromise = import("${REMOTE_ENTRY_ID}")
    // __tla only serves as a hack for vite-plugin-top-level-await. 
    Promise.resolve(remoteEntryPromise)
      .then(remoteEntry => {
        return Promise.resolve(remoteEntry.__tla)
          .then(remoteEntry.init).catch(remoteEntry.init)
      })
    `);
}
export function getHostAutoInitImportId() {
  return hostAutoInitModule.getImportId();
}
export function getHostAutoInitPath() {
  return hostAutoInitModule.getPath();
}
