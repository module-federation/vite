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
export function getRemoteVirtualModule(remote: string, command: string) {
  if (!cacheRemoteMap[remote]) {
    cacheRemoteMap[remote] = new VirtualModule(remote, LOAD_REMOTE_TAG, '.mjs');
    cacheRemoteMap[remote].writeSync(generateRemotes(remote, command));
  }
  const virtual = cacheRemoteMap[remote];
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
export function generateRemotes(id: string, command: string) {
  const useReactProxy = command === 'serve' && hasPackageDependency('react');
  const reactImportLine = useReactProxy ? `import * as __mfReact from "react";` : '';
  const importLine =
    command === 'build'
      ? `${getRuntimeModuleCacheBootstrapCode()}
    import { hostInitPromise as __mfHostInitPromise } from ${JSON.stringify(getHostAutoInitPath())};`
      : `${getRuntimeInitBootstrapCode()}
    const { initPromise, moduleCache: __mfModuleCache } = globalThis[globalKey];`;
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
  const mod = await __mfRemotePending;
  if (mod !== undefined) exportModule = mod;
}
export const __moduleExports = exportModule;
export const __mf_remote_pending = Promise.resolve(exportModule);
export default exportModule?.__esModule ? exportModule.default : exportModule.default ?? exportModule`
      : command === 'build'
        ? `if (__mfRemotePending) {
  const mod = await __mfRemotePending;
  if (mod !== undefined) exportModule = mod;
}
export const __moduleExports = exportModule;
export const __mf_remote_pending = Promise.resolve(exportModule);
export default exportModule?.__esModule ? exportModule.default : exportModule.default ?? exportModule`
        : 'export default exportModule';
  const devProxyCode =
    command !== 'build'
      ? `
    function __mfCreateRemoteProxy(pendingPromise) {
      const listeners = new Set();
      pendingPromise?.finally(() => {
        for (const listener of listeners) listener();
      });
      const getModule = () => __mfModuleCache.remote[${JSON.stringify(id)}];
      const proxyTarget = function (...args) {
        ${
          useReactProxy
            ? `const [, setVersion] = __mfReact.useState(0);
        __mfReact.useEffect(() => {
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
        ${useReactProxy ? `return null;` : `throw pendingPromise;`}
      };
      return new Proxy(proxyTarget, {
        get(_target, prop) {
          if (prop === "__mf_is_remote_proxy") return true;
          if (prop === "__esModule") return true;
          if (prop === "then") return undefined;
          const mod = getModule();
          if (mod) {
            return prop in mod ? mod[prop] : mod.default?.[prop];
          }
          ${useReactProxy ? `return undefined;` : `throw pendingPromise;`}
        },
        ownKeys() {
          const mod = getModule();
          if (!mod) return [];
          return Reflect.ownKeys(mod);
        },
        getOwnPropertyDescriptor(_target, prop) {
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
    }`
      : '';

  return `
    ${reactImportLine}
    ${importLine}
    ${devProxyCode}
    let __mfRemotePending;
    let exportModule = __mfModuleCache.remote[${JSON.stringify(id)}]
    if (exportModule === undefined) {
      ${
        command !== 'build'
          ? `const pendingKey = ${JSON.stringify(`__mf_pending__${id}`)};
      if (!__mfModuleCache.remote[pendingKey]) {
        __mfModuleCache.remote[pendingKey] = initPromise
          .then((runtime) => runtime.loadRemote(${JSON.stringify(id)}))
          .then((mod) => {
            __mfModuleCache.remote[${JSON.stringify(id)}] = mod;
            delete __mfModuleCache.remote[pendingKey];
            return mod;
          })
          .catch(() => {
            delete __mfModuleCache.remote[pendingKey];
          });
      }`
          : ''
      }
      ${
        command !== 'build'
          ? `__mfRemotePending = __mfModuleCache.remote[pendingKey];
      exportModule = __mfCreateRemoteProxy(__mfRemotePending);`
          : `const pendingKey = ${JSON.stringify(`__mf_pending__${id}`)};
      if (!__mfModuleCache.remote[pendingKey]) {
        __mfModuleCache.remote[pendingKey] = __mfHostInitPromise
          .then((runtime) => runtime.loadRemote(${JSON.stringify(id)}))
          .then((mod) => {
            __mfModuleCache.remote[${JSON.stringify(id)}] = mod;
            delete __mfModuleCache.remote[pendingKey];
            return mod;
          })
          .catch((error) => {
            delete __mfModuleCache.remote[pendingKey];
            throw error;
          });
      }
      __mfRemotePending = __mfModuleCache.remote[pendingKey];
      exportModule = {};`
      }
    }
    ${exportLine}
  `;
}
