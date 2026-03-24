import VirtualModule from '../utils/VirtualModule';
import {
  getModuleFederationScopeKey,
  getNormalizeModuleFederationOptions,
  ModuleFederationScopeOptions,
} from '../utils/normalizeModuleFederationOptions';
import {
  getRuntimeInitBootstrapCode,
  getRuntimeInitImportId,
  getRuntimeInitPromiseBootstrapCode,
} from './virtualRuntimeInitStatus';

const cacheRemoteMap = new Map<string, VirtualModule>();
const usedRemotesMap = new Map<string, Record<string, Set<string>>>();

function resolveScopeOptions(options?: ModuleFederationScopeOptions): ModuleFederationScopeOptions {
  return options || getNormalizeModuleFederationOptions();
}

function getRemoteCacheKey(
  remote: string,
  command: string,
  isRolldown: boolean,
  options?: ModuleFederationScopeOptions
) {
  const resolvedOptions = resolveScopeOptions(options);
  const format = isRolldown || command === 'build' ? 'esm' : 'cjs';
  return `${getModuleFederationScopeKey(resolvedOptions)}:${format}:${remote}`;
}

export const LOAD_REMOTE_TAG = '__loadRemote__';

export function getRemoteVirtualModule(
  remote: string,
  command: string,
  isRolldown: boolean,
  options?: ModuleFederationScopeOptions
) {
  const resolvedOptions = resolveScopeOptions(options);
  const cacheKey = getRemoteCacheKey(remote, command, isRolldown, resolvedOptions);
  let virtual = cacheRemoteMap.get(cacheKey);

  if (!virtual) {
    const ext = isRolldown ? '.mjs' : '.js';
    virtual = new VirtualModule(remote, LOAD_REMOTE_TAG, ext, {
      name: resolvedOptions.name,
      virtualModuleDir: resolvedOptions.virtualModuleDir,
    });
    virtual.writeSync(generateRemotes(remote, command, isRolldown, resolvedOptions));
    cacheRemoteMap.set(cacheKey, virtual);
  }

  return virtual;
}

export function addUsedRemote(
  remoteKey: string,
  remoteModule: string,
  options?: ModuleFederationScopeOptions
) {
  const scopeKey = getModuleFederationScopeKey(resolveScopeOptions(options));
  let scopeRemotes = usedRemotesMap.get(scopeKey);

  if (!scopeRemotes) {
    scopeRemotes = {};
    usedRemotesMap.set(scopeKey, scopeRemotes);
  }

  if (!scopeRemotes[remoteKey]) scopeRemotes[remoteKey] = new Set();
  scopeRemotes[remoteKey].add(remoteModule);
}

export function getUsedRemotesMap(options?: ModuleFederationScopeOptions) {
  const scopeKey = getModuleFederationScopeKey(resolveScopeOptions(options));
  let scopeRemotes = usedRemotesMap.get(scopeKey);

  if (!scopeRemotes) {
    scopeRemotes = {};
    usedRemotesMap.set(scopeKey, scopeRemotes);
  }

  return scopeRemotes;
}

export function generateRemotes(
  id: string,
  command: string,
  isRolldown: boolean,
  options?: ModuleFederationScopeOptions
) {
  const useESM = command === 'build' || isRolldown;
  const importLine =
    command === 'build'
      ? getRuntimeInitPromiseBootstrapCode(options)
      : useESM
        ? `${getRuntimeInitBootstrapCode(options)}
    const { initPromise } = globalThis[globalKey];`
        : `const {initPromise} = require("${getRuntimeInitImportId(command, options)}")`;
  const awaitOrPlaceholder = useESM
    ? 'await '
    : '/*mf top-level-await placeholder replacement mf*/';
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
