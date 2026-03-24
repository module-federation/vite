import {
  getLocalSharedImportMapPath_temp,
  writeLocalSharedImportMap_temp,
} from '../utils/localSharedImportMap_temp';
import {
  getModuleFederationScopeKey,
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
  ModuleFederationScopeOptions,
  NormalizedModuleFederationOptions,
} from '../utils/normalizeModuleFederationOptions';
import { hasPackageDependency } from '../utils/packageUtils';
import { serializeRuntimeOptions } from '../utils/serializeRuntimeOptions';
import VirtualModule from '../utils/VirtualModule';
import { getVirtualExposesId } from './virtualExposes';
import { getUsedRemotesMap } from './virtualRemotes';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitResolveBootstrapCode,
} from './virtualRuntimeInitStatus';
import { getSharedImportSource } from './virtualShared_preBuild';

const usedSharesByScope = new Map<string, Set<string>>();
const prevLocalSharedImportMapContentByScope = new Map<string, string>();
const hostAutoInitModules = new Map<string, VirtualModule>();

function resolveScopeOptions(options?: ModuleFederationScopeOptions): ModuleFederationScopeOptions {
  return options || getNormalizeModuleFederationOptions();
}

function resolveNormalizedOptions(
  options?: NormalizedModuleFederationOptions
): NormalizedModuleFederationOptions {
  return options || getNormalizeModuleFederationOptions();
}

function getUsedSharesSet(options?: ModuleFederationScopeOptions) {
  const scopeKey = getModuleFederationScopeKey(resolveScopeOptions(options));
  let usedShares = usedSharesByScope.get(scopeKey);

  if (!usedShares) {
    usedShares = new Set();
    usedSharesByScope.set(scopeKey, usedShares);
  }

  return usedShares;
}

export function getUsedShares(options?: ModuleFederationScopeOptions) {
  return getUsedSharesSet(options);
}

export function addUsedShares(pkg: string, options?: ModuleFederationScopeOptions) {
  getUsedSharesSet(options).add(pkg);
}

export function getLocalSharedImportMapPath(options?: ModuleFederationScopeOptions) {
  const resolvedOptions = resolveScopeOptions(options);
  return getLocalSharedImportMapPath_temp(resolvedOptions.name);
}

export function writeLocalSharedImportMap(options?: NormalizedModuleFederationOptions) {
  const resolvedOptions = resolveNormalizedOptions(options);
  const scopeKey = getModuleFederationScopeKey(resolvedOptions);
  const nextContent = generateLocalSharedImportMap(resolvedOptions);

  if (prevLocalSharedImportMapContentByScope.get(scopeKey) !== nextContent) {
    prevLocalSharedImportMapContentByScope.set(scopeKey, nextContent);
    writeLocalSharedImportMap_temp(nextContent, resolvedOptions.name);
  }
}

export function generateLocalSharedImportMap(options?: NormalizedModuleFederationOptions) {
  const resolvedOptions = resolveNormalizedOptions(options);
  const isVinext = hasPackageDependency('vinext');
  return `
    import {loadShare} from "@module-federation/runtime";
    const importMap = {
      ${Array.from(getUsedShares(resolvedOptions))
        .sort()
        .map((pkg) => {
          const shareItem = getNormalizeShareItem(pkg);
          return `
        ${JSON.stringify(pkg)}: async () => {
          ${
            shareItem?.shareConfig.import === false
              ? `throw new Error(\`[Module Federation] Shared module '\${${JSON.stringify(pkg)}}' must be provided by host\`);`
              : isVinext && pkg === 'react'
                ? `let pkg = await import("react");
            return pkg;`
                : `let pkg = await import(${JSON.stringify(getSharedImportSource(pkg, shareItem, resolvedOptions))});
            return pkg;`
          }
        }
      `;
        })
        .join(',')}
    }
      const usedShared = {
      ${Array.from(getUsedShares(resolvedOptions))
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
            from: ${JSON.stringify(resolvedOptions.name)},
            async get () {
              if (${shareItem.shareConfig.import === false}) {
                throw new Error(\`[Module Federation] Shared module '\${${JSON.stringify(key)}}' must be provided by host\`);
              }
              usedShared[${JSON.stringify(key)}].loaded = true
              const {${JSON.stringify(key)}: pkgDynamicImport} = importMap
              const res = await pkgDynamicImport()
              const exportModule = ${JSON.stringify(isVinext)} && ${JSON.stringify(key)} === "react"
                ? (res?.default ?? res)
                : {...res}
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
      const usedRemotes = [${Object.keys(getUsedRemotesMap(resolvedOptions))
        .map((key) => {
          const remote = resolvedOptions.remotes[key];
          if (!remote) return null;
          return `
                {
                  entryGlobalName: ${JSON.stringify(remote.entryGlobalName)},
                  name: ${JSON.stringify(remote.name)},
                  type: ${JSON.stringify(remote.type)},
                  entry: ${JSON.stringify(remote.entry)},
                  shareScope: ${JSON.stringify(remote.shareScope) ?? 'default'},
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

const REMOTE_ENTRY_ID = 'virtual:mf-REMOTE_ENTRY_ID';

export function getRemoteEntryId(
  options: Pick<NormalizedModuleFederationOptions, 'name' | 'filename'>
) {
  const scopedKey = `${options.name}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
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
  import {init as runtimeInit, loadRemote} from "@module-federation/runtime";
  ${pluginImportNames.map((item) => item[1]).join('\n')}
  ${
    command === 'build'
      ? getRuntimeInitResolveBootstrapCode(options)
      : getRuntimeInitBootstrapCode(options) + '\n  const { initResolve } = globalThis[globalKey];'
  }
  const initTokens = {}
  const shareScopeName = ${JSON.stringify(options.shareScope)}
  const mfName = ${JSON.stringify(options.name)}
  let localSharedImportMapPromise
  let exposesMapPromise

  async function getLocalSharedImportMap() {
    localSharedImportMapPromise ??= import("${getLocalSharedImportMapPath(options)}")
    return localSharedImportMapPromise
  }

  async function getExposesMap() {
    exposesMapPromise ??= import("${virtualExposesId}").then((mod) => mod.default ?? mod)
    return exposesMapPromise
  }

  async function init(shared = {}, initScope = []) {
    const {usedShared, usedRemotes} = await getLocalSharedImportMap()
    const initRes = runtimeInit({
      name: mfName,
      remotes: usedRemotes,
      shared: usedShared,
      plugins: [${pluginImportNames.map((item) => `${item[0]}(${item[2]})`).join(', ')}],
      ${options.shareStrategy ? `shareStrategy: '${options.shareStrategy}'` : ''}
    });
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

export const HOST_AUTO_INIT_TAG = '__H_A_I__';

function getHostAutoInitModule(options?: ModuleFederationScopeOptions) {
  const resolvedOptions = resolveScopeOptions(options);
  const scopeKey = getModuleFederationScopeKey(resolvedOptions);
  let hostAutoInitModule = hostAutoInitModules.get(scopeKey);

  if (!hostAutoInitModule) {
    hostAutoInitModule = new VirtualModule('hostAutoInit', HOST_AUTO_INIT_TAG, '', {
      name: resolvedOptions.name,
      virtualModuleDir: resolvedOptions.virtualModuleDir,
    });
    hostAutoInitModules.set(scopeKey, hostAutoInitModule);
  }

  return hostAutoInitModule;
}

export function writeHostAutoInit(
  remoteEntryId = REMOTE_ENTRY_ID,
  options?: ModuleFederationScopeOptions
) {
  getHostAutoInitModule(options).writeSync(
    `
    const remoteEntry = await import("${remoteEntryId}");
    await remoteEntry.init();
    `,
    true
  );
}
export function getHostAutoInitImportId(options?: ModuleFederationScopeOptions) {
  return getHostAutoInitModule(options).getImportId();
}
export function getHostAutoInitPath(options?: ModuleFederationScopeOptions) {
  return getHostAutoInitModule(options).getPath();
}
