import { getNormalizeModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
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
export function getRemoteVirtualModule(remote: string, command: string, enableSsrInit = false) {
  const cacheKey = `${remote}__${command}__${enableSsrInit ? 'ssr' : 'no-ssr'}`;
  if (!cacheRemoteMap[cacheKey]) {
    cacheRemoteMap[cacheKey] = new VirtualModule(remote, LOAD_REMOTE_TAG, '.mjs');
    cacheRemoteMap[cacheKey].writeSync(generateRemotes(remote, command, enableSsrInit));
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

type RemoteExportStrategy = 'await-real' | 'deferred-client';

function resolveRemoteExportStrategy(command: string, shareStrategy: string): RemoteExportStrategy {
  if (command === 'build') return 'await-real';
  if (shareStrategy === 'loaded-first') return 'deferred-client';
  return 'await-real';
}

export function generateRemotes(id: string, command: string, enableSsrInit = false) {
  const options = getNormalizeModuleFederationOptions();
  const isLoadedFirst = options.shareStrategy === 'loaded-first';
  const exportStrategy = resolveRemoteExportStrategy(command, options.shareStrategy);
  const useDeferredClient = exportStrategy === 'deferred-client' && command === 'serve';
  const remoteName = id.split('/')[0];
  const remote = options.remotes[remoteName];
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
  const importLine =
    command === 'build'
      ? `${getRuntimeModuleCacheBootstrapCode()}
    import { hostInitPromise as __mfHostInitPromise } from ${JSON.stringify(getHostAutoInitPath())};`
      : `${getRuntimeInitBootstrapCode(enableSsrInit)}
    const { initPromise, initResolve, initReject, moduleCache: __mfModuleCache } = globalThis[globalKey];
    if (typeof window !== "undefined") {
      import(${JSON.stringify(getHostAutoInitPath())})
        .then((mod) => mod.hostInitPromise)
        .then(initResolve, initReject);
    }`;
  const unwrapHelper = `
    function __mfUnwrapRemoteDefault(mod) {
      if (mod == null) return mod;
      if (mod.__esModule && mod.default != null) return mod.default;
      return mod.default ?? mod;
    }`;
  const deferredProxyCode = `
    function __mfCreateDeferredRemoteProxy(pendingPromise) {
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
  const remotePendingExport = useDeferredClient
    ? `export const __mf_remote_pending = __mfRemotePending ?? Promise.resolve(exportModule);`
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
${useDeferredClient ? '' : resolveRemoteExport}
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

  const initExportModule = useDeferredClient
    ? `if (typeof window === "undefined") {
      __mfRemotePending = __mfStartRemoteLoad();
      exportModule = await __mfRemotePending;
    } else {
      exportModule = __mfCreateDeferredRemoteProxy();
    }`
    : `__mfRemotePending = __mfStartRemoteLoad();`;

  return `
    ${importLine}
    ${remoteLoadCode}
    ${useDeferredClient ? deferredProxyCode : ''}
    ${unwrapHelper}
    let __mfRemotePending;
    let exportModule = __mfModuleCache.remote[${JSON.stringify(id)}]
    if (exportModule === undefined) {
      ${initExportModule}
    }
    ${exportLine}
  `;
}
