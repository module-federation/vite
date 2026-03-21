import VirtualModule from '../utils/VirtualModule';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitPromiseBootstrapCode,
  virtualRuntimeInitStatus,
} from './virtualRuntimeInitStatus';

const cacheRemoteMap: {
  [remote: string]: VirtualModule;
} = {};
const remoteVersionMap: Record<string, number> = {};
export const LOAD_REMOTE_TAG = '__loadRemote__';
export function getRemoteVirtualModule(remote: string, command: string, isRolldown: boolean) {
  if (!cacheRemoteMap[remote]) {
    const ext = isRolldown ? '.mjs' : '.js';
    cacheRemoteMap[remote] = new VirtualModule(remote, LOAD_REMOTE_TAG, ext);
    cacheRemoteMap[remote].writeSync(generateRemotes(remote, command, isRolldown));
  }
  const virtual = cacheRemoteMap[remote];
  return virtual;
}
export function invalidateRemoteVirtualModule(remote: string): VirtualModule | undefined {
  const virtual = cacheRemoteMap[remote];
  if (!virtual) return;

  remoteVersionMap[remote] = (remoteVersionMap[remote] || 0) + 1;
  virtual.writeSync(generateRemotes(remote, 'serve', virtual.suffix === '.mjs'), true);
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
export function generateRemotes(id: string, command: string, isRolldown: boolean) {
  const useESM = command === 'build' || isRolldown;
  const hmrVersion = remoteVersionMap[id] || 0;
  const importLine =
    command === 'build'
      ? getRuntimeInitPromiseBootstrapCode()
      : useESM
        ? `${getRuntimeInitBootstrapCode()}
    const { initPromise } = globalThis[globalKey];`
        : `const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")`;
  const awaitOrPlaceholder = useESM
    ? 'await '
    : '/*mf top-level-await placeholder replacement mf*/';
  // In dev+ESM mode (rolldown/Vite 8), unwrap the module namespace to avoid
  // double-wrapping: loadRemote returns {default: Component}, and
  // "export default exportModule" would make import() return
  // {default: {default: Component}}, breaking React.lazy.
  // In build mode, the module-federation-esm-shims plugin handles this.
  const exportLine =
    command === 'serve' && useESM
      ? `
    let __mfExportDefault = exportModule.default ?? exportModule
    export { __mfExportDefault as default }
    if (import.meta.hot) {
      import.meta.hot.accept((newModule) => {
        if (!newModule || !('default' in newModule)) {
          import.meta.hot.invalidate()
          return
        }
        __mfExportDefault = newModule.default
      })
    }`
      : useESM
        ? 'export default exportModule'
        : 'module.exports = exportModule';
  const hmrPrelude =
    command === 'serve'
      ? `
    const __mfHmrVersion = ${hmrVersion};
    function __mfFindRemote(runtime) {
      const remotes = runtime && runtime.options && Array.isArray(runtime.options.remotes)
        ? runtime.options.remotes
        : []
      return remotes.find((remote) => ${JSON.stringify(id)} === remote.name || ${JSON.stringify(
        id
      )}.startsWith(remote.name + "/"))
    }
    function __mfClearRemoteCache(runtime) {
      const remote = __mfFindRemote(runtime)
      if (!remote || !runtime || !runtime.remoteHandler) return
      const nextRemote = { ...remote }
      runtime.remoteHandler.removeRemote(remote)
      if (typeof runtime.registerRemotes === "function") {
        runtime.registerRemotes([nextRemote])
      }
    }
    const res = initPromise.then(runtime => {
      if (__mfHmrVersion > 0) {
        __mfClearRemoteCache(runtime)
      }
      return runtime.loadRemote(${JSON.stringify(id)})
    })`
      : '';

  return `
    ${importLine}
    ${hmrPrelude}
    ${command === 'serve' ? '' : `const res = initPromise.then(runtime => runtime.loadRemote(${JSON.stringify(id)}))`}
    const exportModule = ${awaitOrPlaceholder}initPromise.then(_ => res)
    ${exportLine}
  `;
}
