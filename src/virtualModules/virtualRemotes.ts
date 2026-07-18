import {
  getNormalizeModuleFederationOptions,
  type NormalizedModuleFederationOptions,
  type RemoteObjectConfig,
} from '../utils/normalizeModuleFederationOptions';
import type { RemoteConsumer } from '../utils/remoteConsumerTarget';
import { SERVER_ENV_GUARD } from '../utils/ssrCapabilities';
import VirtualModule from '../utils/VirtualModule';
import { getHostAutoInitPath } from './virtualRemoteEntry';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeRemoteAlias,
  getRuntimeRemoteCachePrefix,
  getRuntimeInitStatusImportId,
  getRuntimeModuleCacheBootstrapCode,
} from './virtualRuntimeInitStatus';

const cacheRemoteMap = new WeakMap<NormalizedModuleFederationOptions, Map<string, VirtualModule>>();
const remoteOptionsIds = new WeakMap<NormalizedModuleFederationOptions, number>();
let nextRemoteOptionsId = 1;

function getRemoteOptionsId(options: NormalizedModuleFederationOptions): number {
  let id = remoteOptionsIds.get(options);
  if (id === undefined) {
    id = nextRemoteOptionsId++;
    remoteOptionsIds.set(options, id);
  }
  return id;
}
export const LOAD_REMOTE_TAG = '__loadRemote__';

export function getRemoteVirtualModule(
  remote: string,
  command: string,
  enableSsrInit = false,
  consumer: RemoteConsumer = 'unified',
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  let instanceCache = cacheRemoteMap.get(options);
  if (!instanceCache) {
    instanceCache = new Map();
    cacheRemoteMap.set(options, instanceCache);
  }
  const cacheKey = `${remote}__${command}__${options.shareStrategy}__${consumer}__${enableSsrInit ? 'ssr-init' : 'no-ssr-init'}`;
  if (!instanceCache.has(cacheKey)) {
    // Environment API graphs must not share a virtual id. VirtualModule's
    // registry is process-global, so an SSR wrapper registered after a client
    // wrapper would otherwise replace it and make the browser receive server
    // code (notably without the client host-init import). Keep the historical
    // id for legacy/unified graphs.
    const consumerName = consumer === 'unified' ? remote : `${remote}__mf_consumer__${consumer}`;
    const virtualName = `${consumerName}__mf_owner__${getRemoteOptionsId(options)}`;
    const virtual = new VirtualModule(virtualName, LOAD_REMOTE_TAG, '.js', options.internalName);
    virtual.writeSync(generateRemotes(remote, command, enableSsrInit, consumer, options));
    instanceCache.set(cacheKey, virtual);
  }
  return instanceCache.get(cacheKey)!;
}
const usedRemotesMap: Record<string, Set<string>> = {
  // remote1: {remote1/App, remote1, remote1/Button}
};
const usedRemotesByOptions = new WeakMap<
  NormalizedModuleFederationOptions,
  Record<string, Set<string>>
>();

function getScopedUsedRemotesMap(options: NormalizedModuleFederationOptions) {
  let scoped = usedRemotesByOptions.get(options);
  if (!scoped) {
    scoped = {};
    usedRemotesByOptions.set(options, scoped);
  }
  return scoped;
}

function recordUsedRemote(
  map: Record<string, Set<string>>,
  remoteKey: string,
  remoteModule: string
) {
  if (!map[remoteKey]) map[remoteKey] = new Set();
  map[remoteKey].add(remoteModule);
}

export function addUsedRemote(
  remoteKey: string,
  remoteModule: string,
  options?: NormalizedModuleFederationOptions
) {
  recordUsedRemote(usedRemotesMap, remoteKey, remoteModule);
  if (options) recordUsedRemote(getScopedUsedRemotesMap(options), remoteKey, remoteModule);
}
export function getUsedRemotesMap(options?: NormalizedModuleFederationOptions) {
  if (options) return getScopedUsedRemotesMap(options);
  return usedRemotesMap;
}

function getRemoteAliasFromId(id: string, remotes: Record<string, RemoteObjectConfig>) {
  return Object.keys(remotes)
    .filter((name) => id === name || id.startsWith(name + '/'))
    .sort((a, b) => b.length - a.length)[0];
}

export function getRemoteFromId(id: string, remotes: Record<string, RemoteObjectConfig>) {
  const remoteAlias = getRemoteAliasFromId(id, remotes);
  return remoteAlias ? remotes[remoteAlias] : undefined;
}

export function getRuntimeRemoteId(
  id: string,
  remotes: Record<string, RemoteObjectConfig>,
  _options?: NormalizedModuleFederationOptions
) {
  // Keep the configured remote key (e.g. "remote/App") for loadRemote.
  // Instance isolation uses scoped remote `name` in usedRemotes / registerRemotes
  // and getRuntimeRemoteCachePrefix in the module cache — not a scoped request id.
  // Scoping the request id breaks consumers like @module-federation/astro that
  // resolve localRemotes / createInstance remotes by the configured alias.
  void remotes;
  void _options;
  return id;
}

/**
 * How a generated remote wrapper loads at module evaluation time.
 *
 * - `eager`: version-first — start `loadRemote` immediately, resolve via promise chain
 * - `loaded-first-ssr`: SSR/client split — real module (proxies are invalid on the server)
 * - `loaded-first-client`: browser split — defer until an export is read
 * - `loaded-first-unified`: single graph — a Node guard picks SSR vs browser behavior
 */
export type RemoteInitMode =
  | 'eager'
  | 'loaded-first-ssr'
  | 'loaded-first-client'
  | 'loaded-first-unified';

export function resolveRemoteInitMode(
  shareStrategy: string,
  consumer: RemoteConsumer
): RemoteInitMode {
  if (shareStrategy !== 'loaded-first') return 'eager';
  if (consumer === 'server') return 'loaded-first-ssr';
  if (consumer === 'client') return 'loaded-first-client';
  return 'loaded-first-unified';
}

function shouldDeferRemoteLoad(initMode: RemoteInitMode) {
  return initMode === 'loaded-first-client' || initMode === 'loaded-first-unified';
}

/** Dev client wrappers can preload remotes while exposing stable proxies. */
function shouldEagerLoadClientRemoteInDev(command: string, enableSsrInit: boolean) {
  return enableSsrInit && command === 'serve';
}

function getEagerDeferredClientInit() {
  return `__mfRemotePending = __mfStartRemoteLoad().then(__mfAssignRemoteModule);
      exportModule = __mfCreateDeferredRemoteProxy();`;
}

function shouldIncludeDeferredProxy(
  initMode: RemoteInitMode,
  consumer: RemoteConsumer,
  eagerLoadClientRemote: boolean,
  deferRemoteLoad: boolean
) {
  if (eagerLoadClientRemote && consumer !== 'server') return true;
  if (initMode === 'eager') {
    return consumer !== 'server' && (consumer === 'unified' || !eagerLoadClientRemote);
  }
  if (consumer === 'client' && eagerLoadClientRemote) return false;
  return deferRemoteLoad || consumer !== 'server';
}

/** Codegen shared by every remote virtual module (no top-level await). */
function getRemoteModuleRuntimeHelpers() {
  return `
    function __mfUnwrapRemoteDefault(mod) {
      let value = mod;
      // A federated expose can pass through more than one ESM/CJS namespace
      // wrapper (notably with React/Preact lazy imports). Keep unwrapping
      // explicit default namespaces until the actual component is reached.
      const seen = new Set();
      while (value != null && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        if (value.__esModule && value.default != null) {
          value = value.default;
          continue;
        }
        if (!value.__esModule && value.default != null) {
          value = value.default;
          continue;
        }
        break;
      }
      return value;
    }
    let __mfDefaultExport;
    function __mfSyncDefaultExport() {
      __mfDefaultExport = exportModule?.__mf_is_remote_proxy
        ? exportModule
        : __mfUnwrapRemoteDefault(exportModule);
    }
    function __mfAssignRemoteModule(mod) {
      if (mod !== undefined) exportModule = mod;
      __mfSyncDefaultExport();
      return exportModule;
    }`;
}

function getDeferredProxyHelper(remoteCacheKey: string) {
  return `
    function __mfCreateDeferredRemoteProxy() {
      let pendingPromise;
      const ensurePending = () => {
        pendingPromise ||= __mfStartRemoteLoad();
        return pendingPromise;
      };
      const getModule = () => __mfModuleCache.remote[${JSON.stringify(remoteCacheKey)}];
      const proxyTarget = function (...args) {
        pendingPromise ||= __mfStartRemoteLoad();
        const mod = getModule();
        const fn = mod && (mod.default ?? mod);
        if (fn !== undefined && fn !== null) {
          return fn.apply(this, args);
        }
        return null;
      };
      return new Proxy(proxyTarget, {
        get(_target, prop) {
          if (prop === "__mf_is_remote_proxy") return true;
          if (prop === "__esModule") return true;
          if (prop === "then") return undefined;
          if (prop === Symbol.toPrimitive || prop === "toString")
            return () => "[MF remote: pending]";
          const mod = getModule();
          if (mod) {
            return prop in mod ? mod[prop] : mod.default?.[prop];
          }
          pendingPromise ||= __mfStartRemoteLoad();
          if (prop === "default") return proxyTarget;
          throw ensurePending();
        },
        has(_target, prop) {
          const mod = getModule();
          if (mod) return prop in mod;
          return (
            prop === "default" ||
            prop === "__esModule" ||
            prop === "__mf_is_remote_proxy"
          );
        },
        ownKeys() {
          const mod = getModule();
          const keys = new Set(mod ? Reflect.ownKeys(mod) : []);
          for (const k of Reflect.ownKeys(proxyTarget)) {
            const d = Object.getOwnPropertyDescriptor(proxyTarget, k);
            if (d && !d.configurable) keys.add(k);
          }
          return Array.from(keys);
        },
        getOwnPropertyDescriptor(_target, prop) {
          const targetDesc = Object.getOwnPropertyDescriptor(proxyTarget, prop);
          if (targetDesc && !targetDesc.configurable) return targetDesc;
          const mod = getModule();
          if (!mod) return undefined;
          return Object.getOwnPropertyDescriptor(mod, prop) || {
            configurable: true,
            enumerable: true,
            value: mod[prop],
          };
        },
        apply(target, thisArg, args) {
          return target.apply(thisArg, args);
        }
      });
    }`;
}

function getLazyRemotePendingExport() {
  return `export const __mf_remote_pending = __mfRemotePending ?? {
  then(onFulfilled, onRejected) {
    return (__mfRemotePending ??= __mfStartRemoteLoad().then(__mfAssignRemoteModule)).then(onFulfilled, onRejected);
  },
};`;
}

function getEagerRemotePendingExport() {
  return `export const __mf_remote_pending =
  __mfRemotePending ??
  __mfStartRemoteLoad().then(__mfAssignRemoteModule);`;
}

function getServerThenExport() {
  return `export function then(onFulfilled, onRejected) {
  return (__mfRemotePending ?? Promise.resolve(exportModule))
    .then(__mfAssignRemoteModule)
    .then(() => {
      __mfSyncDefaultExport();
      return {
        ...exportModule,
        default: __mfDefaultExport,
        __moduleExports: exportModule,
        __mf_remote_pending: __mfRemotePending,
      };
    })
    .then(onFulfilled, onRejected);
}`;
}

function getRemoteExportBlock(command: string, deferRemoteLoad: boolean, consumer: RemoteConsumer) {
  if (command !== 'serve' && command !== 'build') {
    return `__mfSyncDefaultExport();
export { __mfDefaultExport as default };`;
  }
  return `__mfSyncDefaultExport();
__mfRemotePending?.then(__mfSyncDefaultExport, () => {});
export { exportModule as __moduleExports };
${deferRemoteLoad ? getLazyRemotePendingExport() : getEagerRemotePendingExport()}
${command === 'serve' && consumer === 'server' ? getServerThenExport() : ''}
export { __mfDefaultExport as default };`;
}

export function generateRemotes(
  id: string,
  command: string,
  enableSsrInit = false,
  consumer: RemoteConsumer = 'unified',
  options?: NormalizedModuleFederationOptions
) {
  const resolvedOptions = options ?? getNormalizeModuleFederationOptions();
  const isLoadedFirst = resolvedOptions.shareStrategy === 'loaded-first';
  const initMode = resolveRemoteInitMode(resolvedOptions.shareStrategy, consumer);
  const deferRemoteLoad = shouldDeferRemoteLoad(initMode);
  const remoteAlias = getRemoteAliasFromId(id, resolvedOptions.remotes);
  const remote = remoteAlias ? resolvedOptions.remotes[remoteAlias] : undefined;
  const runtimeRemoteName = remoteAlias
    ? options
      ? getRuntimeRemoteAlias(remoteAlias, options)
      : remote?.name
    : undefined;
  const runtimeRemoteId = getRuntimeRemoteId(id, resolvedOptions.remotes, options);
  const registerRemoteCode =
    isLoadedFirst && remote && remoteAlias
      ? `runtime.registerRemotes([${JSON.stringify({
          entryGlobalName: remote.entryGlobalName,
          name: runtimeRemoteName ?? remote.name,
          // Keep the configured alias so loadRemote("remote/...") still matches
          // after #926 scoped the unique remote name for instance isolation.
          alias: remoteAlias,
          type: remote.type,
          entry: remote.entry,
          shareScope: remote.shareScope ?? 'default',
        })}]);`
      : '';
  const hostAutoInitPath = getHostAutoInitPath(options);
  const ssrRemotes = Object.entries(resolvedOptions.remotes).map(([name, item]) => ({
    // SSR bootstrap instance is dedicated (`__mf_ssr_host__`); use the configured
    // remote key so loadRemote ids stay compatible with localRemotes consumers.
    name,
    entry: item.entry,
    type: item.type ?? 'module',
  }));
  const browserHostInitCode = `import(${JSON.stringify(hostAutoInitPath)})
        .then((mod) => mod.hostInitPromise)
        .then(initResolve, initReject);`;
  const devRuntimeBootstrap = `${getRuntimeInitBootstrapCode(
    enableSsrInit,
    getRuntimeInitStatusImportId(options),
    ssrRemotes,
    hostAutoInitPath
  )}
    const { initPromise, initResolve, initReject, moduleCache: __mfModuleCache } = globalThis[globalKey];`;
  const devHostInitLine = command === 'serve' && consumer !== 'server' ? browserHostInitCode : '';
  const importLine =
    command === 'build'
      ? `${getRuntimeModuleCacheBootstrapCode()}
    import { hostInitPromise as __mfHostInitPromise } from ${JSON.stringify(hostAutoInitPath)};`
      : `${devRuntimeBootstrap}
    ${devHostInitLine}`;
  const remoteLoadRuntimePromise = command === 'build' ? '__mfHostInitPromise' : 'initPromise';
  const remoteCacheKey = `${getRuntimeRemoteCachePrefix(options)}${id}`;
  const remoteLoadFailureHandler =
    command === 'build'
      ? `.catch((error) => {
            delete __mfModuleCache.remote[pendingKey];
            throw error;
          })`
      : `.catch((error) => {
            delete __mfModuleCache.remote[pendingKey];
            throw error;
          })`;
  const startRemoteLoadCode = `
      const remoteCacheKey = ${JSON.stringify(remoteCacheKey)};
      const pendingKey = "__mf_pending__" + remoteCacheKey;
      if (!__mfModuleCache.remote[pendingKey]) {
        __mfModuleCache.remote[pendingKey] = ${remoteLoadRuntimePromise}
          .then((runtime) => {
            ${registerRemoteCode}
            return runtime.loadRemote(${JSON.stringify(runtimeRemoteId)});
          })
          .then((mod) => Promise.resolve(mod?.__mf_remote_dependency_pending).then(() => mod))
          .then((mod) => {
            __mfModuleCache.remote[remoteCacheKey] = mod;
            delete __mfModuleCache.remote[pendingKey];
            return mod;
          })
          ${remoteLoadFailureHandler};
      }
      return __mfModuleCache.remote[pendingKey];`;
  const remoteLoadCode = `
    function __mfStartRemoteLoad() {
      ${startRemoteLoadCode}
    }`;

  const realRemoteInit = `__mfRemotePending = __mfStartRemoteLoad().then(__mfAssignRemoteModule);`;
  const deferredClientInit = `exportModule = __mfCreateDeferredRemoteProxy();`;
  const eagerLoadClientRemote = shouldEagerLoadClientRemoteInDev(command, enableSsrInit);
  const eagerClientInit = eagerLoadClientRemote ? getEagerDeferredClientInit() : deferredClientInit;
  const loadedFirstClientInit = eagerLoadClientRemote
    ? getEagerDeferredClientInit()
    : deferredClientInit;
  const environmentSplitInit = (clientInit: string, serverInit: string) =>
    consumer === 'client'
      ? clientInit
      : consumer === 'server'
        ? serverInit
        : `if (${SERVER_ENV_GUARD}) {
      ${serverInit}
    } else {
      ${clientInit}
    }`;
  const initExportModule =
    initMode === 'eager'
      ? environmentSplitInit(eagerClientInit, realRemoteInit)
      : environmentSplitInit(loadedFirstClientInit, realRemoteInit);

  const includeProxyHelper = shouldIncludeDeferredProxy(
    initMode,
    consumer,
    eagerLoadClientRemote,
    deferRemoteLoad
  );

  const deferredProxyCode = getDeferredProxyHelper(remoteCacheKey);

  return `
    ${importLine}
    ${remoteLoadCode}
    ${includeProxyHelper ? deferredProxyCode : ''}
    ${getRemoteModuleRuntimeHelpers()}
    let __mfRemotePending;
    let exportModule = __mfModuleCache.remote[${JSON.stringify(remoteCacheKey)}]
    if (exportModule === undefined) {
      ${initExportModule}
    }
    ${getRemoteExportBlock(command, deferRemoteLoad, consumer)}
  `;
}
