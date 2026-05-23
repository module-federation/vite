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

// Serialised remotes config for the SSR runtime — populated by writeRuntimeInitStatus
// from the host's remotes option so loadRemote knows where to find each remote.
let _ssrRemotes: Array<{ name: string; entry: string; type: string }> = [];

export function setSsrRemotes(remotes: Array<{ name: string; entry: string; type: string }>) {
  _ssrRemotes = remotes;
}

// enableSsrInit controls whether the server-side MF runtime initialisation block
// is emitted in dev remote wrappers. Gating is centralized in getSsrCapabilities()
// (Vite 8+ dev ModuleRunner; build/preview uses HTTP fetch via ssrEntryLoader).
function getSsrNoopResolveCode(enableSsrInit: boolean) {
  if (!enableSsrInit) return '';

  // On the server, initialise a real MF runtime with ssrEntryLoader so that
  // loadRemote triggers loadEntry and ssrEntryLoader can fetch the SSR remote
  // entry via ModuleRunner (Vite 8+). The runtime is configured with the same
  // remotes as the host so loadRemote resolves the correct entry URLs.
  //
  // @vite-ignore comments prevent Vite from scanning these dynamic imports for
  // dep optimization or client-bundle inclusion — they only run server-side.
  //
  // Falls back to noops if the runtime is unavailable.
  const remotesJson = JSON.stringify(_ssrRemotes);
  return `if (typeof window === 'undefined') {
    var _noop = { loadRemote: function() { return Promise.resolve(undefined); }, loadShare: function() { return Promise.resolve(undefined); } };
    import(/* @vite-ignore */ '@module-federation/runtime').then(function(runtimeMod) {
      return import(/* @vite-ignore */ '@module-federation/vite/ssrEntryLoader').then(
        function(loaderMod) { return [runtimeMod, [loaderMod.default()]]; },
        function() { return [runtimeMod, []]; }
      );
    }).then(function(pair) {
      var runtime = pair[0].init({ name: '__mf_ssr_host__', remotes: ${remotesJson}, shared: {}, plugins: pair[1] });
      initResolve(runtime);
    }, function() {
      initResolve(_noop);
    });
  }`;
}

function getRuntimeInitStateBootstrapCode(options: {
  globalKeyVar: string;
  stateVar: string;
  exposedConst: string;
  exposedProperty: 'initPromise' | 'initResolve';
  enableSsrInit: boolean;
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
  ${getSsrNoopResolveCode(options.enableSsrInit)}
}
const ${options.exposedConst} = ${options.stateVar}.${options.exposedProperty};
`;
}

export function getRuntimeInitBootstrapCode(enableSsrInit = false) {
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
  ${getSsrNoopResolveCode(enableSsrInit)}
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
export function getRuntimeInitPromiseBootstrapCode(enableSsrInit = false) {
  return getRuntimeInitStateBootstrapCode({
    globalKeyVar: '__mfPromiseGlobalKey',
    stateVar: '__mfPromiseState',
    exposedConst: 'initPromise',
    exposedProperty: 'initPromise',
    enableSsrInit,
  });
}

// Build-time remoteEntry only needs initResolve.
// It intentionally differs from the initPromise bootstrap so bundlers don't
// merge remoteEntry and loadShare onto the same shared runtime snippet.
export function getRuntimeInitResolveBootstrapCode(enableSsrInit = false) {
  return getRuntimeInitStateBootstrapCode({
    globalKeyVar: '__mfResolveGlobalKey',
    stateVar: '__mfResolveState',
    exposedConst: 'initResolve',
    exposedProperty: 'initResolve',
    enableSsrInit,
  });
}

export function writeRuntimeInitStatus(command: string, enableSsrInit = false) {
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject, moduleCache } = globalThis[globalKey];
export { initPromise, initResolve, initReject, moduleCache };`
      : `module.exports = globalThis[globalKey];`;

  virtualRuntimeInitStatus.writeSync(`
${getRuntimeInitBootstrapCode(enableSsrInit)}
${exportStatement}
`);
}
