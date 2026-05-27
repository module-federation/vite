import {
  getNormalizeModuleFederationOptions,
  type RemoteObjectConfig,
} from '../utils/normalizeModuleFederationOptions';
import type { RemoteConsumer } from '../utils/remoteConsumerTarget';
import { hasPackageDependency } from '../utils/packageUtils';
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
 * - `eager`: version-first — start `loadRemote` immediately, await via top-level export hook
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

function usesEnvironmentSplit(initMode: RemoteInitMode, command: string) {
  return (
    (initMode === 'loaded-first-client' || initMode === 'loaded-first-ssr') &&
    (command === 'serve' || command === 'build')
  );
}

function shouldDeferRemoteLoad(initMode: RemoteInitMode) {
  return initMode === 'loaded-first-client' || initMode === 'loaded-first-unified';
}

export function generateRemotes(
  id: string,
  command: string,
  enableSsrInit = false,
  consumer: RemoteConsumer = 'unified'
) {
  const useReactProxy = hasPackageDependency('react');
  const options = getNormalizeModuleFederationOptions();
  const isLoadedFirst = options.shareStrategy === 'loaded-first';
  const initMode = resolveRemoteInitMode(options.shareStrategy, consumer);
  const useSplitConsumer = usesEnvironmentSplit(initMode, command);
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
  const reactImportLine = useReactProxy
    ? `import __mfReactDefault from "react";
    import * as __mfReactNamespace from "react";
    const __mfReact = __mfReactDefault ?? __mfReactNamespace.default ?? __mfReactNamespace;`
    : '';
  const browserHostInitCode = `import(${JSON.stringify(getHostAutoInitPath())})
        .then((mod) => mod.hostInitPromise)
        .then(initResolve, initReject);`;
  const devRuntimeBootstrap = `${getRuntimeInitBootstrapCode(enableSsrInit)}
    const { initPromise, initResolve, initReject, moduleCache: __mfModuleCache } = globalThis[globalKey];`;
  const importLine =
    command === 'build'
      ? `${getRuntimeModuleCacheBootstrapCode()}
    import { hostInitPromise as __mfHostInitPromise } from ${JSON.stringify(getHostAutoInitPath())};`
      : useSplitConsumer && consumer === 'server'
        ? devRuntimeBootstrap
        : useSplitConsumer && consumer === 'client'
          ? `${devRuntimeBootstrap}
    ${browserHostInitCode}`
          : `${devRuntimeBootstrap}
    if (typeof window !== "undefined") {
      ${browserHostInitCode}
    }`;
  const unwrapHelper = `
    function __mfUnwrapRemoteDefault(mod) {
      if (mod == null) return mod;
      if (mod.__esModule && mod.default != null) return mod.default;
      return mod.default ?? mod;
    }`;
  const reactRemoteProxyCode = `
    function __mfCreateRemoteProxy(pendingPromise) {
      const listeners = new Set();
      const ensurePending = () => {
        pendingPromise ||= __mfStartRemoteLoad();
        pendingPromise?.finally(() => {
          for (const listener of listeners) listener();
        });
        return pendingPromise;
      };
      const getModule = () => __mfModuleCache.remote[${JSON.stringify(id)}];
      const proxyTarget = function (...args) {
        const [, setVersion] = __mfReact.useState(0);
        __mfReact.useEffect(() => {
          ensurePending();
          const listener = () => setVersion((value) => value + 1);
          listeners.add(listener);
          if (getModule()) listener();
          return () => listeners.delete(listener);
        }, []);
        const mod = getModule();
        const fn = mod && (mod.default ?? mod);
        if (fn !== undefined && fn !== null) {
          return __mfReact.createElement(fn, args[0]);
        }
        return null;
      };
      return new Proxy(proxyTarget, {
        get(_target, prop) {
          if (prop === "__mf_is_remote_proxy") return true;
          if (prop === "__esModule") return true;
          if (prop === "then") return undefined;
          if (prop === Symbol.toPrimitive || prop === "toString")
            return () => "[MF remote proxy: pending]";
          const mod = getModule();
          if (mod) {
            return prop in mod ? mod[prop] : mod.default?.[prop];
          }
          if (prop === "default") return proxyTarget;
          return undefined;
        },
        has(_target, prop) {
          const mod = getModule();
          if (mod) return prop in mod;
          return prop === "default" || prop === "__esModule" || prop === "__mf_is_remote_proxy";
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
  const deferredProxyCode = `
    function __mfCreateDeferredRemoteProxy() {
      let pendingPromise;
      const ensurePending = () => {
        pendingPromise ||= __mfStartRemoteLoad();
        return pendingPromise;
      };
      const getModule = () => __mfModuleCache.remote[${JSON.stringify(id)}];
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
  const resolveRemoteExport = `
    if (!exportModule?.__mf_is_remote_proxy) {
      if (exportModule === undefined) {
        __mfRemotePending ??= __mfStartRemoteLoad();
        exportModule = await __mfRemotePending;
      }
    }`;
  const defaultExportLine = `export default exportModule?.__mf_is_remote_proxy ? exportModule : __mfUnwrapRemoteDefault(exportModule)`;
  const remotePendingThenable = `{
  then(onFulfilled, onRejected) {
    __mfRemotePending ??= __mfStartRemoteLoad().then((mod) => {
      if (mod !== undefined) exportModule = mod;
      return exportModule;
    });
    return __mfRemotePending.then(onFulfilled, onRejected);
  },
}`;
  const remotePendingExport = deferRemoteLoad
    ? `export const __mf_remote_pending = __mfRemotePending ?? ${remotePendingThenable}`
    : `export const __mf_remote_pending =
  __mfRemotePending ??
  __mfStartRemoteLoad().then((mod) => {
    if (mod !== undefined) exportModule = mod;
    return exportModule;
  });`;
  const exportLine =
    command === 'serve' || command === 'build'
      ? `if (__mfRemotePending) {
  __mfRemotePending = __mfRemotePending.then((mod) => {
    if (mod !== undefined) exportModule = mod;
    return exportModule;
  });
}
export { exportModule as __moduleExports };
${remotePendingExport}
${deferRemoteLoad ? '' : resolveRemoteExport}
${defaultExportLine}`
      : `${resolveRemoteExport}
${defaultExportLine}`;
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

  const deferredClientInit = useReactProxy
    ? `__mfRemotePending = __mfStartRemoteLoad();
      exportModule = __mfCreateRemoteProxy(__mfRemotePending);`
    : `exportModule = __mfCreateDeferredRemoteProxy();`;
  const deferredServerInit = `__mfRemotePending = __mfStartRemoteLoad();
      exportModule = await __mfRemotePending;`;
  const initExportModule =
    initMode === 'eager'
      ? `__mfRemotePending = __mfStartRemoteLoad();`
      : useSplitConsumer && initMode === 'loaded-first-ssr'
        ? deferredServerInit
        : useSplitConsumer && initMode === 'loaded-first-client'
          ? deferredClientInit
          : `if (typeof window === "undefined") {
      ${deferredServerInit}
    } else {
      ${deferredClientInit}
    }`;

  const proxyHelperCode = useReactProxy ? reactRemoteProxyCode : deferredProxyCode;
  const includeProxyHelper = deferRemoteLoad;

  return `
    ${reactImportLine}
    ${importLine}
    ${remoteLoadCode}
    ${includeProxyHelper ? proxyHelperCode : ''}
    ${unwrapHelper}
    let __mfRemotePending;
    let exportModule = __mfModuleCache.remote[${JSON.stringify(id)}]
    if (exportModule === undefined) {
      ${initExportModule}
    }
    ${exportLine}
  `;
}
