import VirtualModule from '../utils/VirtualModule';

export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
const MODULE_CACHE_GLOBAL_KEY = '__mf_module_cache__';

export function getRuntimeInitGlobalKey() {
  return `__mf_init__${virtualRuntimeInitStatus.getImportId()}__`;
}

export function getRuntimeInitBootstrapCode() {
  return `
const globalKey = ${JSON.stringify(getRuntimeInitGlobalKey())};
const moduleCacheGlobalKey = ${JSON.stringify(MODULE_CACHE_GLOBAL_KEY)};
globalThis[moduleCacheGlobalKey] ||= { share: {}, remote: {} };
globalThis[moduleCacheGlobalKey].share ||= {};
globalThis[moduleCacheGlobalKey].remote ||= {};
if (!globalThis[globalKey]) {
  let initResolve, initReject;
  const initPromise = new Promise((re, rj) => {
    initResolve = re;
    initReject = rj;
  });
  globalThis[globalKey] = {
    initPromise,
    initResolve,
    initReject,
    moduleCache: globalThis[moduleCacheGlobalKey],
  };
  if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }
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
  return `
const __mfPromiseGlobalKey = ${JSON.stringify(getRuntimeInitGlobalKey())};
let __mfPromiseState = globalThis[__mfPromiseGlobalKey];
if (!__mfPromiseState) {
  let initResolve, initReject;
  const initPromise = new Promise((re, rj) => {
    initResolve = re;
    initReject = rj;
  });
  __mfPromiseState = globalThis[__mfPromiseGlobalKey] = {
    initPromise,
    initResolve,
    initReject,
  };
  if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }
}
const initPromise = __mfPromiseState.initPromise;
`;
}

// Build-time remoteEntry only needs initResolve.
// It intentionally differs from the initPromise bootstrap so bundlers don't
// merge remoteEntry and loadShare onto the same shared runtime snippet.
export function getRuntimeInitResolveBootstrapCode() {
  return `
const __mfResolveGlobalKey = ${JSON.stringify(getRuntimeInitGlobalKey())};
let __mfResolveState = globalThis[__mfResolveGlobalKey];
if (!__mfResolveState) {
  let initResolve, initReject;
  const initPromise = new Promise((re, rj) => {
    initResolve = re;
    initReject = rj;
  });
  __mfResolveState = globalThis[__mfResolveGlobalKey] = {
    initPromise,
    initResolve,
    initReject,
  };
  if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }
}
const initResolve = __mfResolveState.initResolve;
`;
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
