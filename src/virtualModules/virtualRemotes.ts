import VirtualModule from '../utils/VirtualModule';
import { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';

const cacheRemoteMap: {
  [remote: string]: VirtualModule;
} = {};
export const LOAD_REMOTE_TAG = '__loadRemote__';
export function getRemoteVirtualModule(remote: string, command: string) {
  if (!cacheRemoteMap[remote]) {
    // Use .mjs extension to ensure ESM treatment by bundlers
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
  // Generate ESM-compatible code to fix Vite 7/Rolldown compatibility
  // The previous CJS code (require + module.exports + top-level await) caused syntax errors
  // because Rolldown wraps CJS in a function where top-level await is invalid
  return `
    // Use dynamic import instead of require for ESM compatibility
    const runtimeModule = await import("${virtualRuntimeInitStatus.getImportId()}")
    const {initPromise} = runtimeModule
    const res = initPromise.then(runtime => runtime.loadRemote(${JSON.stringify(id)}))
    const exportModule = ${command !== 'build' ? '/*mf top-level-await placeholder replacement mf*/' : 'await '}initPromise.then(_ => res)
    // Use ESM export instead of module.exports to avoid CJS wrapper issues
    export default exportModule
  `;
}
