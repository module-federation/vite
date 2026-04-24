import VirtualModule from '../utils/VirtualModule';

export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
const MODULE_CACHE_GLOBAL_KEY = '__mf_module_cache__';

export function getRuntimeInitGlobalKey() {
  return `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
}

function getDeferredInitPromiseCode() {
  return `let initResolve, initReject;
  const initPromise = new Promise((re, rj) => {
    initResolve = re;
    initReject = rj;
  });`;
}

function getSsrNoopResolveCode() {
  return `if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }`;
}

function getRuntimeInitStateBootstrapCode(options: {
  globalKeyVar: string;
  stateVar: string;
  exposedConst: string;
  exposedProperty: 'initPromise' | 'initResolve';
}) {
  return `
const ${options.globalKeyVar} = ${JSON.stringify(getRuntimeInitGlobalKey())};
let ${options.stateVar} = globalThis[${options.globalKeyVar}];
if (!${options.stateVar}) {
  ${getDeferredInitPromiseCode()}
  ${options.stateVar} = globalThis[${options.globalKeyVar}] = {
    initPromise,
    initResolve,
    initReject,
  };
  ${getSsrNoopResolveCode()}
}
const ${options.exposedConst} = ${options.stateVar}.${options.exposedProperty};
`;
}

export function getRuntimeInitBootstrapCode() {
  return `
const globalKey = ${JSON.stringify(getRuntimeInitGlobalKey())};
const moduleCacheGlobalKey = ${JSON.stringify(MODULE_CACHE_GLOBAL_KEY)};
globalThis[moduleCacheGlobalKey] ||= { share: {}, remote: {} };
globalThis[moduleCacheGlobalKey].share ||= {};
globalThis[moduleCacheGlobalKey].remote ||= {};
if (!globalThis[globalKey]) {
  ${getDeferredInitPromiseCode()}
  globalThis[globalKey] = {
    initPromise,
    initResolve,
    initReject,
    moduleCache: globalThis[moduleCacheGlobalKey],
  };
  ${getSsrNoopResolveCode()}
}
globalThis[globalKey].moduleCache ||= globalThis[moduleCacheGlobalKey];
globalThis[globalKey].moduleCache.share ||= {};
globalThis[globalKey].moduleCache.remote ||= {};
`;
}

export function getRuntimeModuleCacheBootstrapCode() {
  return `
const __mfCacheGlobalKey = ${JSON.stringify(MODULE_CACHE_GLOBAL_KEY)};
globalThis[__mfCacheGlobalKey] ||= { share: {}, remote: {} };
globalThis[__mfCacheGlobalKey].share ||= {};
globalThis[__mfCacheGlobalKey].remote ||= {};
const __mfModuleCache = globalThis[__mfCacheGlobalKey];
`;
}

// Build-time shared/remotes shims only need initPromise.
// Keep this bootstrap text distinct from remoteEntry's initResolve bootstrap,
// otherwise Rolldown can dedupe them and recreate the loadShare deadlock.
export function getRuntimeInitPromiseBootstrapCode() {
  return getRuntimeInitStateBootstrapCode({
    globalKeyVar: '__mfPromiseGlobalKey',
    stateVar: '__mfPromiseState',
    exposedConst: 'initPromise',
    exposedProperty: 'initPromise',
  });
}

// Build-time remoteEntry only needs initResolve.
// It intentionally differs from the initPromise bootstrap so bundlers don't
// merge remoteEntry and loadShare onto the same shared runtime snippet.
export function getRuntimeInitResolveBootstrapCode() {
  return getRuntimeInitStateBootstrapCode({
    globalKeyVar: '__mfResolveGlobalKey',
    stateVar: '__mfResolveState',
    exposedConst: 'initResolve',
    exposedProperty: 'initResolve',
  });
}

export function writeRuntimeInitStatus(command: string) {
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject, moduleCache } = globalThis[globalKey];
export { initPromise, initResolve, initReject, moduleCache };`
      : `module.exports = globalThis[globalKey];`;

  virtualRuntimeInitStatus.writeSync(`
${getRuntimeInitBootstrapCode()}
${exportStatement}
`);
}
