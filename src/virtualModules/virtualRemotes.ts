import {
  getNormalizeModuleFederationOptions,
  type RemoteObjectConfig,
} from '../utils/normalizeModuleFederationOptions';
import type { RemoteConsumer } from '../utils/remoteConsumerTarget';
import VirtualModule from '../utils/VirtualModule';
import { getHostAutoInitPath } from './virtualRemoteEntry';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeModuleCacheBootstrapCode,
} from './virtualRuntimeInitStatus';

const cacheRemoteMap: {
  [remote: string]: VirtualModule;
} = {};
export const LOAD_REMOTE_TAG = '__loadRemote__';

export function getRemoteVirtualModule(
  remote: string,
  command: string,
  enableSsrInit = false,
  consumer: RemoteConsumer = 'unified'
) {
  const { shareStrategy } = getNormalizeModuleFederationOptions();
  const cacheKey = `${remote}__${command}__${shareStrategy}__${consumer}__${enableSsrInit ? 'ssr-init' : 'no-ssr-init'}`;
  if (!cacheRemoteMap[cacheKey]) {
    cacheRemoteMap[cacheKey] = new VirtualModule(remote, LOAD_REMOTE_TAG, '.mjs');
    cacheRemoteMap[cacheKey].writeSync(generateRemotes(remote, command, enableSsrInit, consumer));
  }
  const virtual = cacheRemoteMap[cacheKey];
  return virtual;
}
const usedRemotesMap: Record<string, Set<string>> = {
  // remote1: {remote1/App, remote1, remote1/Button}
};
export function addUsedRemote(remoteKey: string, remoteModule: string) {
  if (!usedRemotesMap[remoteKey]) usedRemotesMap[remoteKey] = new Set();
  usedRemotesMap[remoteKey].add(remoteModule);
}
export function getUsedRemotesMap() {
  return usedRemotesMap;
}

export function getRemoteFromId(id: string, remotes: Record<string, RemoteObjectConfig>) {
  const remoteName = Object.keys(remotes)
    .filter((name) => id === name || id.startsWith(name + '/'))
    .sort((a, b) => b.length - a.length)[0];

  return remoteName ? remotes[remoteName] : undefined;
}

/**
 * How a generated remote wrapper loads at module evaluation time.
 *
 * - `eager`: version-first — start `loadRemote` immediately, resolve via promise chain
 * - `loaded-first-ssr`: SSR/client split — real module (proxies are invalid on the server)
 * - `loaded-first-client`: browser split — defer until an export is read
 * - `loaded-first-unified`: single graph — `typeof window` picks SSR vs browser behavior
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

function shouldIncludeDeferredProxy(
  initMode: RemoteInitMode,
  consumer: RemoteConsumer,
  enableSsrInit: boolean,
  deferRemoteLoad: boolean
) {
  if (initMode === 'eager') {
    return consumer !== 'server' && (consumer === 'unified' || !enableSsrInit);
  }
  if (consumer === 'client' && enableSsrInit) return false;
  return deferRemoteLoad || consumer !== 'server';
}

/** Codegen shared by every remote virtual module (no top-level await). */
function getRemoteModuleRuntimeHelpers() {
  return `
    function __mfUnwrapRemoteDefault(mod) {
      if (mod == null) return mod;
      if (mod.__esModule && mod.default != null) return mod.default;
      return mod.default ?? mod;
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

function getDeferredProxyHelper(remoteId: string) {
  return `
    function __mfCreateDeferredRemoteProxy() {
      let pendingPromise;
      const ensurePending = () => {
        pendingPromise ||= __mfStartRemoteLoad();
        return pendingPromise;
      };
      const getModule = () => __mfModuleCache.remote[${JSON.stringify(remoteId)}];
      const proxyTarget = function (...args) {
        const mod = getModule();
        const fn = mod && (mod.default ?? mod);
        if (fn !== undefined && fn !== null) {
          return fn.apply(this, args);
        }
        throw ensurePending();
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
          throw ensurePending();
        },
        has(_target, prop) {
          const mod = getModule();
          if (mod) return prop in mod;
          return false;
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

function getRemoteExportBlock(command: string, deferRemoteLoad: boolean) {
  if (command !== 'serve' && command !== 'build') {
    return `__mfSyncDefaultExport();
export default __mfDefaultExport`;
  }
  return `__mfRemotePending?.then(__mfSyncDefaultExport);
export { exportModule as __moduleExports };
${deferRemoteLoad ? getLazyRemotePendingExport() : getEagerRemotePendingExport()}
export default __mfDefaultExport`;
}

export function generateRemotes(
  id: string,
  command: string,
  enableSsrInit = false,
  consumer: RemoteConsumer = 'unified'
) {
  const options = getNormalizeModuleFederationOptions();
  const isLoadedFirst = options.shareStrategy === 'loaded-first';
  const initMode = resolveRemoteInitMode(options.shareStrategy, consumer);
  const deferRemoteLoad = shouldDeferRemoteLoad(initMode);
  const remote = getRemoteFromId(id, options.remotes);
  const registerRemoteCode =
    isLoadedFirst && remote
      ? `runtime.registerRemotes([${JSON.stringify({
          entryGlobalName: remote.entryGlobalName,
          name: remote.name,
          type: remote.type,
          entry: remote.entry,
          shareScope: remote.shareScope ?? 'default',
        })}]);`
      : '';
  const browserHostInitCode = `import(${JSON.stringify(getHostAutoInitPath())})
        .then((mod) => mod.hostInitPromise)
        .then(initResolve, initReject);`;
  const devRuntimeBootstrap = `${getRuntimeInitBootstrapCode(enableSsrInit, getHostAutoInitPath())}
    const { initPromise, initResolve, initReject, moduleCache: __mfModuleCache } = globalThis[globalKey];`;
  const devHostInitLine = command === 'serve' && consumer !== 'server' ? browserHostInitCode : '';
  const importLine =
    command === 'build'
      ? `${getRuntimeModuleCacheBootstrapCode()}
    import { hostInitPromise as __mfHostInitPromise } from ${JSON.stringify(getHostAutoInitPath())};`
      : `${devRuntimeBootstrap}
    ${devHostInitLine}`;
  const remoteLoadRuntimePromise = command === 'build' ? '__mfHostInitPromise' : 'initPromise';
  const remoteLoadFailureHandler =
    command === 'build'
      ? `.catch((error) => {
            delete __mfModuleCache.remote[pendingKey];
            throw error;
          })`
      : `.catch(() => {
            delete __mfModuleCache.remote[pendingKey];
          })`;
  const startRemoteLoadCode = `
      const pendingKey = ${JSON.stringify(`__mf_pending__${id}`)};
      if (!__mfModuleCache.remote[pendingKey]) {
        __mfModuleCache.remote[pendingKey] = ${remoteLoadRuntimePromise}
          .then((runtime) => {
            ${registerRemoteCode}
            return runtime.loadRemote(${JSON.stringify(id)});
          })
          .then((mod) => {
            __mfModuleCache.remote[${JSON.stringify(id)}] = mod;
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
  const eagerClientInit = enableSsrInit ? realRemoteInit : deferredClientInit;
  const loadedFirstClientInit = enableSsrInit ? realRemoteInit : deferredClientInit;
  const environmentSplitInit = (clientInit: string, serverInit: string) =>
    consumer === 'client'
      ? clientInit
      : consumer === 'server'
        ? serverInit
        : `if (typeof window === "undefined") {
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
    enableSsrInit,
    deferRemoteLoad
  );

  const deferredProxyCode = getDeferredProxyHelper(id);

  return `
    ${importLine}
    ${remoteLoadCode}
    ${includeProxyHelper ? deferredProxyCode : ''}
    ${getRemoteModuleRuntimeHelpers()}
    let __mfRemotePending;
    let exportModule = __mfModuleCache.remote[${JSON.stringify(id)}]
    if (exportModule === undefined) {
      ${initExportModule}
    }
    ${getRemoteExportBlock(command, deferRemoteLoad)}
  `;
}
