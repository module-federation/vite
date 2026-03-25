import VirtualModule from '../utils/VirtualModule';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitPromiseBootstrapCode,
  virtualRuntimeInitStatus,
} from './virtualRuntimeInitStatus';

const cacheRemoteMap: {
  [remote: string]: VirtualModule;
} = {};
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
  // In dev+ESM mode (Vite 8+), unwrap the module namespace to avoid
  // double-wrapping: loadRemote returns {default: Component}, and
  // "export default exportModule" would make import() return
  // {default: {default: Component}}, breaking React.lazy.
  // In build mode, the module-federation-esm-shims plugin handles this.
  const exportLine =
    command === 'serve' && useESM
      ? 'export default exportModule.default ?? exportModule'
      : useESM
        ? 'export default exportModule'
        : 'module.exports = exportModule';

  return `
    ${importLine}
    const res = initPromise.then(runtime => runtime.loadRemote(${JSON.stringify(id)}))
    const exportModule = ${awaitOrPlaceholder}initPromise.then(_ => res)
    ${exportLine}
  `;
}
