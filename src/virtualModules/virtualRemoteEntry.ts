import {
  getLocalSharedImportMapPath_temp,
  writeLocalSharedImportMap_temp,
} from '../utils/localSharedImportMap_temp';
import {
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
  NormalizedModuleFederationOptions,
  ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';
import { serializeRuntimeOptions } from '../utils/serializeRuntimeOptions';
import VirtualModule from '../utils/VirtualModule';
import { getVirtualExposesId } from './virtualExposes';
import { getUsedRemotesMap } from './virtualRemotes';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitResolveBootstrapCode,
  getRuntimeModuleCacheBootstrapCode,
} from './virtualRuntimeInitStatus';
import {
  getConcreteSharedImportSource,
  getLocalProviderImportPath,
  getProjectResolvedImportPath,
  getSharedImportSource,
} from './virtualShared_preBuild';

let usedShares: Set<string> = new Set();
export function getUsedShares() {
  return usedShares;
}
export function addUsedShares(pkg: string) {
  usedShares.add(pkg);
}
export function getLocalSharedImportMapPath() {
  return getLocalSharedImportMapPath_temp();
}
let prevLocalSharedImportMapContent: string | undefined;
export function writeLocalSharedImportMap() {
  const nextContent = generateLocalSharedImportMap();
  if (prevLocalSharedImportMapContent !== nextContent) {
    prevLocalSharedImportMapContent = nextContent;
    writeLocalSharedImportMap_temp(nextContent);
    //   localSharedImportMapModule.writeSync(generateLocalSharedImportMap(), true)
  }
}

function shouldUseDirectReactImport() {
  const isVinext = hasPackageDependency('vinext');
  const isAstro = hasPackageDependency('astro');
  return isVinext || isAstro;
}

function getLocalSharedPackagePath(pkg: string, shareItem: ShareItem) {
  const useDirectReactImport = shouldUseDirectReactImport();
  if (useDirectReactImport && pkg === 'react') return 'react';

  return (
    getConcreteSharedImportSource(pkg, shareItem) ||
    getLocalProviderImportPath(pkg) ||
    getSharedImportSource(pkg, shareItem)
  );
}

function getDirectSharedCacheSeedImportPath(pkg: string, shareItem: ShareItem) {
  return (
    getConcreteSharedImportSource(pkg, shareItem) ||
    getProjectResolvedImportPath(pkg) ||
    getLocalProviderImportPath(pkg) ||
    pkg
  );
}

export function generateLocalSharedImportMap() {
  const useDirectReactImport = shouldUseDirectReactImport();
  const options = getNormalizeModuleFederationOptions();

  return `
    import {loadShare} from "@module-federation/runtime";
    const importMap = {
      ${Array.from(getUsedShares())
        .sort()
        .map((pkg) => {
          const shareItem = getNormalizeShareItem(pkg);
          return `
        ${JSON.stringify(pkg)}: async () => {
          ${
            shareItem?.shareConfig.import === false
              ? `throw new Error(\`[Module Federation] Shared module '\${${JSON.stringify(pkg)}}' must be provided by host\`);`
              : `let pkg = await import(${JSON.stringify(getLocalSharedPackagePath(pkg, shareItem))});
            return pkg;`
          }
        }
      `;
        })
        .join(',')}
    }
      const usedShared = {
      ${Array.from(getUsedShares())
        .sort()
        .map((key) => {
          const shareItem = getNormalizeShareItem(key);
          if (!shareItem) return null;
          return `
          ${JSON.stringify(key)}: {
            name: ${JSON.stringify(key)},
            version: ${JSON.stringify(shareItem.version)},
            scope: [${JSON.stringify(shareItem.scope)}],
            loaded: false,
            from: ${JSON.stringify(options.internalName)},
            async get () {
              if (${shareItem.shareConfig.import === false}) {
                throw new Error(\`[Module Federation] Shared module '\${${JSON.stringify(key)}}' must be provided by host\`);
              }
              usedShared[${JSON.stringify(key)}].loaded = true
              const {${JSON.stringify(key)}: pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = ${JSON.stringify(useDirectReactImport)} && ${JSON.stringify(key)} === "react"
                ? (res?.default ?? res)
                : {...res}
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
              requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)},
              ${shareItem.shareConfig.import === false ? 'import: false,' : ''}
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
                  shareScope: ${JSON.stringify(remote.shareScope ?? 'default')},
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

function generateUsedSharedPreloadConfig() {
  return `{
      ${getOrderedUsedShares()
        .map((pkg) => {
          const shareItem = getShareItemForPreload(pkg);
          if (!shareItem) return null;
          return `${JSON.stringify(pkg)}: {
            shareConfig: {
              singleton: ${shareItem.shareConfig.singleton},
              requiredVersion: ${JSON.stringify(shareItem.shareConfig.requiredVersion)},
              ${shareItem.shareConfig.import === false ? 'import: false,' : ''}
            }
          }`;
        })
        .filter((item) => item !== null)
        .join(',\n')}
    }`;
}

function getOrderedUsedShares() {
  const shares = new Set(getUsedShares());
  try {
    Object.keys(getNormalizeModuleFederationOptions().shared).forEach((pkg) => {
      shares.add(pkg.endsWith('/') ? pkg.slice(0, -1) : pkg);
    });
  } catch {
    // Some isolated unit tests call generators before normalized options exist.
  }
  return Array.from(shares).sort((a, b) => {
    const priority = (pkg: string) =>
      pkg === 'react' ? 0 : pkg === 'react-dom' ? 1 : pkg.startsWith('react/') ? 2 : 3;
    return priority(a) - priority(b) || a.localeCompare(b);
  });
}

function getShareItemForPreload(pkg: string) {
  return getNormalizeShareItem(pkg) || getNormalizeShareItem(`${pkg}/`);
}

export function generateDirectSharedCacheSeedCode(command = 'build') {
  return getOrderedUsedShares()
    .map((pkg) => {
      const shareItem = getShareItemForPreload(pkg);
      if (!shareItem || shareItem.shareConfig.import === false) return null;
      const importPath =
        command === 'serve'
          ? getLocalSharedPackagePath(pkg, shareItem)
          : getDirectSharedCacheSeedImportPath(pkg, shareItem);
      return `if (__mfModuleCache.share[${JSON.stringify(pkg)}] === undefined) {
        const mod = await import(${JSON.stringify(importPath)});
        const exportModule = ${JSON.stringify(shouldUseDirectReactImport())} && ${JSON.stringify(pkg)} === "react"
          ? (mod?.default ?? mod)
          : {...mod};
        Object.defineProperty(exportModule, "__esModule", {
          value: true,
          enumerable: false
        });
        __mfModuleCache.share[${JSON.stringify(pkg)}] = exportModule;
      }`;
    })
    .filter((item) => item !== null)
    .join('\n');
}

const REMOTE_ENTRY_ID = 'virtual:mf-REMOTE_ENTRY_ID';

export function getRemoteEntryId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  const scopedKey = `${options.internalName}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${REMOTE_ENTRY_ID}:${scopedKey}`;
}
export function generateRemoteEntry(
  options: NormalizedModuleFederationOptions,
  virtualExposesId = getVirtualExposesId(options),
  command = 'build'
): string {
  const pluginImportNames = options.runtimePlugins.map((p, i) => {
    if (typeof p === 'string') {
      return [`$runtimePlugin_${i}`, `import $runtimePlugin_${i} from "${p}";`, `undefined`];
    } else {
      return [
        `$runtimePlugin_${i}`,
        `import $runtimePlugin_${i} from "${p[0]}";`,
        serializeRuntimeOptions(p[1]),
      ];
    }
  });

  return `
  // Shim Vue HMR runtime for dev-compiled components loaded by a non-Vite host.
  // When a remote is served by a Vite dev server, Vue's SFC compiler injects HMR
  // hooks that reference __VUE_HMR_RUNTIME__. This global only exists on pages
  // served by Vite's client runtime. When a production host loads the remote,
  // the HMR calls would throw. This no-op shim prevents that.
  if (typeof __VUE_HMR_RUNTIME__ === 'undefined') {
    globalThis.__VUE_HMR_RUNTIME__ = { createRecord() {}, rerender() {}, reload() {} };
  }
  import {init as runtimeInit, loadRemote} from "@module-federation/runtime";
  ${pluginImportNames.map((item) => item[1]).join('\n')}
  ${
    command === 'build'
      ? getRuntimeInitResolveBootstrapCode()
      : getRuntimeInitBootstrapCode() + '\n  const { initResolve } = globalThis[globalKey];'
  }
  ${getRuntimeModuleCacheBootstrapCode()}
  const initTokens = {}
  const shareScopeName = ${JSON.stringify(options.shareScope)}
  const mfName = ${JSON.stringify(options.internalName)}
  let localSharedImportMapPromise
  let exposesMapPromise

  async function getLocalSharedImportMap() {
    localSharedImportMapPromise ??= import("${getLocalSharedImportMapPath()}")
    return localSharedImportMapPromise
  }

  async function getExposesMap() {
    exposesMapPromise ??= import("${virtualExposesId}").then((mod) => mod.default ?? mod)
    return exposesMapPromise
  }

  async function init(shared = {}, initScope = []) {
    const {usedShared, usedRemotes} = await getLocalSharedImportMap()
    ${generateDirectSharedCacheSeedCode(command)}
    const initRes = runtimeInit({
      name: mfName,
      remotes: usedRemotes,
      shared: usedShared,
      plugins: [${pluginImportNames.map((item) => `${item[0]}(${item[2]})`).join(', ')}],
      ${options.shareStrategy ? `shareStrategy: '${options.shareStrategy}'` : ''}
    });
    // handling circular init calls
    var initToken = initTokens[shareScopeName];
    if (!initToken)
      initToken = initTokens[shareScopeName] = { from: mfName };
    if (initScope.indexOf(initToken) >= 0) return;
    initScope.push(initToken);
    initRes.initShareScopeMap('${options.shareScope}', shared);
    initResolve(initRes)
    try {
      await Promise.all(await initRes.initializeSharing('${options.shareScope}', {
        strategy: '${options.shareStrategy}',
        from: "build",
        initScope
      }));
    } catch (e) {
      console.error('[Module Federation]', e)
    }
    return initRes
  }

  async function getExposes(moduleName) {
    const exposesMap = await getExposesMap()
    if (!(moduleName in exposesMap)) throw new Error(\`[Module Federation] Module \${moduleName} does not exist in container.\`)
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
let currentHostAutoInitRemoteEntryId = REMOTE_ENTRY_ID;
let currentHostAutoInitCommand = 'build';
export function generateHostAutoInitCode(remoteEntryImport: string, _command = 'build') {
  return `
    ${getRuntimeModuleCacheBootstrapCode()}
    let hostInitPromise;
    async function initHost() {
      if (!hostInitPromise) {
        hostInitPromise = (async () => {
          const remoteEntry = await import(${remoteEntryImport});
          const runtime = await remoteEntry.init();
          const usedShared = ${generateUsedSharedPreloadConfig()};
          for (const [pkg, share] of Object.entries(usedShared)) {
            if (__mfModuleCache.share[pkg] !== undefined) {
              continue;
            }
            await runtime.loadShare(pkg, {
              customShareInfo: { shareConfig: share.shareConfig }
            }).then((factory) => {
              const mod = typeof factory === "function" ? factory() : factory;
              return Promise.resolve(mod).then((resolved) => {
                __mfModuleCache.share[pkg] = resolved;
              });
            });
          }
          const __mfRemotePreloads = [];
          await Promise.all(__mfRemotePreloads);
          return runtime;
        })();
      }
      return hostInitPromise;
    }
    hostInitPromise = initHost();
    export { initHost, hostInitPromise };
    `;
}
export function writeHostAutoInit(remoteEntryId = REMOTE_ENTRY_ID, command = 'build') {
  currentHostAutoInitRemoteEntryId = remoteEntryId;
  currentHostAutoInitCommand = command;
  hostAutoInitModule.writeSync(
    generateHostAutoInitCode(JSON.stringify(remoteEntryId), command),
    true
  );
}
export function refreshHostAutoInit() {
  try {
    writeHostAutoInit(currentHostAutoInitRemoteEntryId, currentHostAutoInitCommand);
  } catch {
    // Some isolated unit tests exercise share/remote plugins without
    // initializing normalized federation options.
  }
}
export function getHostAutoInitImportId() {
  return hostAutoInitModule.getImportId();
}
export function getHostAutoInitPath() {
  return hostAutoInitModule.getPath();
}
