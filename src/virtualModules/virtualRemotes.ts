import {
  getNormalizeModuleFederationOptions,
  type RemoteObjectConfig,
} from '../utils/normalizeModuleFederationOptions';
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
export function getRemoteVirtualModule(remote: string, command: string, enableSsrInit = false) {
  const cacheKey = `${remote}__${command}__${enableSsrInit ? 'ssr' : 'no-ssr'}`;
  if (!cacheRemoteMap[cacheKey]) {
    cacheRemoteMap[cacheKey] = new VirtualModule(remote, LOAD_REMOTE_TAG, '.js');
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

export function getRemoteFromId(id: string, remotes: Record<string, RemoteObjectConfig>) {
  const remoteName = Object.keys(remotes)
    .filter((name) => id === name || id.startsWith(name + '/'))
    .sort((a, b) => b.length - a.length)[0];

  return remoteName ? remotes[remoteName] : undefined;
}

export function generateRemotes(id: string, command: string, enableSsrInit = false) {
  const useReactProxy = hasPackageDependency('react');
  const useVueProxy = !useReactProxy && hasPackageDependency('vue');
  const options = getNormalizeModuleFederationOptions();
  const isLoadedFirst = options.shareStrategy === 'loaded-first';
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
  const vueImportLine = useVueProxy
    ? `import { defineAsyncComponent as __mfDefineAsyncComponent } from "vue";`
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
  // In dev+ESM mode (Vite 8+), unwrap the module namespace to avoid
  // double-wrapping: loadRemote returns {default: Component}, and
  // "export default exportModule" would make import() return
  // {default: {default: Component}}, breaking React.lazy.
  // In build mode, the module-federation-esm-shims plugin handles this.
  // In dev+ESM mode (rolldown/Vite 8), export __moduleExports alongside
  // default so that the consumer-side transform plugin can extract named
  // exports (Rolldown does not support syntheticNamedExports).
  const exportLine =
    command === 'serve'
      ? `if (__mfRemotePending) {
  __mfRemotePending = __mfRemotePending.then((mod) => {
    if (mod !== undefined) exportModule = mod;
    return exportModule;
  });
}
export { exportModule as __moduleExports };
export const __mf_remote_pending = __mfRemotePending || Promise.resolve(exportModule);
export default exportModule?.__mf_is_remote_proxy ? exportModule : exportModule?.__esModule ? exportModule.default : exportModule.default ?? exportModule`
      : command === 'build'
        ? `if (__mfRemotePending) {
  __mfRemotePending = __mfRemotePending.then((mod) => {
    if (mod !== undefined) exportModule = mod;
    return exportModule;
  });
}
export { exportModule as __moduleExports };
export const __mf_remote_pending = __mfRemotePending || Promise.resolve(exportModule);
export default exportModule?.__mf_is_remote_proxy ? exportModule : exportModule?.__esModule ? exportModule.default : exportModule.default ?? exportModule`
        : 'export default exportModule';
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
          .then((mod) => Promise.resolve(mod?.__mf_remote_dependency_pending).then(() => mod))
          .then((mod) => {
            __mfModuleCache.remote[${JSON.stringify(id)}] = mod;
            delete __mfModuleCache.remote[pendingKey];
            return mod;
          })
          ${remoteLoadFailureHandler};
      }
      return __mfModuleCache.remote[pendingKey];`;
  const remoteProxyCode = `
    function __mfStartRemoteLoad() {
      ${startRemoteLoadCode}
    }
    function __mfCreateRemoteProxy(pendingPromise) {
      const ensurePending = () => {
        pendingPromise ||= __mfStartRemoteLoad();
        ${
          useVueProxy
            ? ''
            : `pendingPromise?.finally(() => {
          for (const listener of listeners) listener();
        });`
        }
        return pendingPromise;
      };
      ${
        useVueProxy
          ? `return __mfDefineAsyncComponent(() =>
        ensurePending().then((mod) => mod?.default ?? mod)
      );`
          : `
      const listeners = new Set();
      const getModule = () => __mfModuleCache.remote[${JSON.stringify(id)}];
      const proxyTarget = function (...args) {
        ${
          useReactProxy
            ? `const [, setVersion] = __mfReact.useState(0);
        __mfReact.useEffect(() => {
          ensurePending();
          const listener = () => setVersion((value) => value + 1);
          listeners.add(listener);
          if (getModule()) listener();
          return () => listeners.delete(listener);
        }, []);`
            : ''
        }
        const mod = getModule();
        const fn = mod && (mod.default ?? mod);
        if (fn !== undefined && fn !== null) {
          ${
            useReactProxy
              ? `return __mfReact.createElement(fn, args[0]);`
              : `return fn.apply(this, args);`
          }
        }
        ${useReactProxy ? `return null;` : `throw ensurePending();`}
      };
      return new Proxy(proxyTarget, {
        get(_target, prop) {
          if (prop === "__mf_is_remote_proxy") return true;
          if (prop === "__esModule") return true;
          if (prop === "then") return undefined;
          // Allow React's dev-mode console.warn to stringify the proxy without
          // throwing "Cannot convert object to primitive value".
          if (prop === Symbol.toPrimitive || prop === "toString")
            return () => "[MF remote proxy: pending]";
          const mod = getModule();
          if (mod) {
            return prop in mod ? mod[prop] : mod.default?.[prop];
          }
          // When the module is pending and React.lazy() checks for "default",
          // return the proxy function itself so React renders it (returns null)
          // rather than crashing on undefined.
          ${
            useReactProxy
              ? `if (prop === "default") return proxyTarget;
          return undefined;`
              : `throw ensurePending();`
          }
        },
        has(_target, prop) {
          const mod = getModule();
          if (mod) return prop in mod;
          // Tell React that "default" exists when module is pending so it
          // doesn't warn "lazy: Expected the result of a dynamic import()".
          ${useReactProxy ? `return prop === "default" || prop === "__esModule" || prop === "__mf_is_remote_proxy";` : `return false;`}
        },
        ownKeys() {
          const mod = getModule();
          const keys = new Set(mod ? Reflect.ownKeys(mod) : []);
          // Proxy invariant: must include non-configurable target own keys
          for (const k of Reflect.ownKeys(proxyTarget)) {
            const d = Object.getOwnPropertyDescriptor(proxyTarget, k);
            if (d && !d.configurable) keys.add(k);
          }
          return Array.from(keys);
        },
        getOwnPropertyDescriptor(_target, prop) {
          // Proxy invariant: non-configurable target props must be reported accurately
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
      });`
      }
    }`;

  return `
    ${reactImportLine}
    ${vueImportLine}
    ${importLine}
    ${remoteProxyCode}
    let __mfRemotePending;
    let exportModule = __mfModuleCache.remote[${JSON.stringify(id)}]
    if (exportModule === undefined) {
      __mfRemotePending = __mfStartRemoteLoad();
      exportModule = __mfCreateRemoteProxy(__mfRemotePending);
    }
    ${exportLine}
  `;
}
