import VirtualModule from '../utils/VirtualModule';
import { virtualRuntimeInitStatus } from './virtualRuntimeInitStatus';

const cacheRemoteMap: {
  [remote: string]: VirtualModule;
} = {};
export const LOAD_REMOTE_TAG = '__loadRemote__';
export function getRemoteVirtualModule(remote: string, command: string) {
  if (!cacheRemoteMap[remote]) {
    cacheRemoteMap[remote] = new VirtualModule(remote, LOAD_REMOTE_TAG, '.js');
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
  const isBuild = command === 'build';
  const importLine = isBuild
    ? `import { initPromise } from "${virtualRuntimeInitStatus.getImportId()}"`
    : `const {initPromise} = require("${virtualRuntimeInitStatus.getImportId()}")`;
  const awaitOrPlaceholder = isBuild
    ? 'await '
    : '/*mf top-level-await placeholder replacement mf*/';
  const exportLine = isBuild
    ? 'export const __moduleExports = exportModule;\n' +
      'export default exportModule.__esModule ? exportModule.default : exportModule'
    : 'module.exports = exportModule';

  return `
    ${importLine}
    const res = initPromise.then(runtime => runtime.loadRemote(${JSON.stringify(id)}))
    const exportModule = ${awaitOrPlaceholder}initPromise.then(_ => res)
    ${exportLine}
  `;
}
