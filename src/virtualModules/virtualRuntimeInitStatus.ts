import VirtualModule from '../utils/VirtualModule';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { SERVER_ENV_GUARD } from '../utils/ssrCapabilities';

export const virtualRuntimeInitStatus = new VirtualModule('runtimeInit');
const runtimeInitModules = new WeakMap<NormalizedModuleFederationOptions, VirtualModule>();
const runtimeInitOwnerIds = new WeakMap<NormalizedModuleFederationOptions, number>();
let nextRuntimeInitOwnerId = 1;
const MODULE_CACHE_GLOBAL_KEY = '__mf_module_cache__';

function getRuntimeInitModule(options?: NormalizedModuleFederationOptions) {
  if (!options) return virtualRuntimeInitStatus;
  let runtimeInitModule = runtimeInitModules.get(options);
  if (!runtimeInitModule) {
    let ownerId = runtimeInitOwnerIds.get(options);
    if (!ownerId) {
      ownerId = nextRuntimeInitOwnerId++;
      runtimeInitOwnerIds.set(options, ownerId);
    }
    runtimeInitModule = new VirtualModule(
      'runtimeInit',
      '__mf_v__',
      '',
      `${options.internalName}__mf_owner__${ownerId}`
    );
    runtimeInitModules.set(options, runtimeInitModule);
  }
  return runtimeInitModule;
}

export function getRuntimeInitStatusImportId(options?: NormalizedModuleFederationOptions) {
  return getRuntimeInitModule(options).getImportId();
}

export function getRuntimeInitGlobalKey(ownerImportId?: string) {
  return `__mf_init__${ownerImportId ?? virtualRuntimeInitStatus.getImportId()}__`;
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
function getSsrNoopResolveCode(
  enableSsrInit: boolean,
  hostInitImportId?: string,
  initResolveExpression = 'initResolve',
  ssrRemotes = _ssrRemotes
) {
  if (!enableSsrInit) return '';

  const hostInitResolveCode = hostInitImportId
    ? `import(${JSON.stringify(hostInitImportId)})
      .then(function(mod) { return mod.hostInitPromise; })
      .then(function(runtime) {
        ${initResolveExpression}(runtime);
        return true;
      })
      .catch(function() {
        return false;
      })`
    : 'Promise.resolve(false)';

  // On the server, initialise a real MF runtime with ssrEntryLoader so that
  // loadRemote triggers loadEntry and ssrEntryLoader can fetch the SSR remote
  // entry via ModuleRunner (Vite 8+). The runtime is configured with the same
  // remotes as the host so loadRemote resolves the correct entry URLs.
  //
  // @vite-ignore comments prevent Vite from scanning these dynamic imports for
  // dep optimization or client-bundle inclusion — they only run server-side.
  //
  // Falls back to noops if the runtime is unavailable.
  const remotesJson = JSON.stringify(ssrRemotes);
  return `if (${SERVER_ENV_GUARD}) {
    var _noop = { loadRemote: function() { return Promise.resolve(undefined); }, loadShare: function() { return Promise.resolve(undefined); } };
    ${hostInitResolveCode}.then(function(resolved) {
      if (resolved) return;
      return import(/* @vite-ignore */ '@module-federation/runtime').then(function(runtimeMod) {
        return import(/* @vite-ignore */ '@module-federation/vite/ssrEntryLoader').then(
          function(loaderMod) { return [runtimeMod, [loaderMod.default()]]; },
          function() { return [runtimeMod, []]; }
        );
      }).then(function(pair) {
        var runtime = pair[0].init({ name: '__mf_ssr_host__', remotes: ${remotesJson}, shared: {}, plugins: pair[1] });
        ${initResolveExpression}(runtime);
      }, function() {
        ${initResolveExpression}(_noop);
      });
    });
  }`;
}

function getRuntimeInitStateBootstrapCode(options: {
  globalKeyVar: string;
  stateVar: string;
  exposedConst: string;
  exposedProperty: 'initPromise' | 'initResolve';
  enableSsrInit: boolean;
  ownerImportId?: string;
  hostInitImportId?: string;
  ssrRemotes?: Array<{ name: string; entry: string; type: string }>;
}) {
  return `
const ${options.globalKeyVar} = ${JSON.stringify(getRuntimeInitGlobalKey(options.ownerImportId))};
let ${options.stateVar} = globalThis[${options.globalKeyVar}];
if (!${options.stateVar}) {
  ${getDeferredInitPromiseCode()}
  ${options.stateVar} = globalThis[${options.globalKeyVar}] = {
    initPromise,
    initResolve,
    initReject,
  };
  ${getSsrNoopResolveCode(
    options.enableSsrInit,
    options.hostInitImportId,
    'initResolve',
    options.ssrRemotes
  )}
}
const ${options.exposedConst} = ${options.stateVar}.${options.exposedProperty};
`;
}

export function getRuntimeInitBootstrapCode(
  enableSsrInit = false,
  ownerImportId?: string,
  ssrRemotes?: Array<{ name: string; entry: string; type: string }>,
  hostInitImportId = ownerImportId
) {
  return `
const globalKey = ${JSON.stringify(getRuntimeInitGlobalKey(ownerImportId))};
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
}
${
  enableSsrInit
    ? `
if (${SERVER_ENV_GUARD} && !globalThis[globalKey].ssrInitStarted) {
  globalThis[globalKey].ssrInitStarted = true;
  ${getSsrNoopResolveCode(enableSsrInit, hostInitImportId, 'globalThis[globalKey].initResolve', ssrRemotes)}
}`
    : ''
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
for (const __mfShareKey of Object.keys(__mfModuleCache.share)) {
  if (__mfShareKey.startsWith("default:")) {
    const __mfLegacyShareKey = __mfShareKey.slice("default:".length);
    if (__mfModuleCache.share[__mfLegacyShareKey] === undefined) {
      __mfModuleCache.share[__mfLegacyShareKey] = __mfModuleCache.share[__mfShareKey];
    }
  } else if (!__mfShareKey.includes(":")) {
    const __mfDefaultShareKey = "default:" + __mfShareKey;
    if (__mfModuleCache.share[__mfDefaultShareKey] === undefined) {
      __mfModuleCache.share[__mfDefaultShareKey] = __mfModuleCache.share[__mfShareKey];
    }
  }
}
`;
}

// Build-time shared/remotes shims only need initPromise.
// Keep this bootstrap text distinct from remoteEntry's initResolve bootstrap,
// otherwise Rolldown can dedupe them and recreate the loadShare deadlock.
export function getRuntimeInitPromiseBootstrapCode(
  enableSsrInit = false,
  ownerImportId?: string,
  ssrRemotes?: Array<{ name: string; entry: string; type: string }>,
  hostInitImportId = ownerImportId
) {
  return getRuntimeInitStateBootstrapCode({
    globalKeyVar: '__mfPromiseGlobalKey',
    stateVar: '__mfPromiseState',
    exposedConst: 'initPromise',
    exposedProperty: 'initPromise',
    enableSsrInit,
    ownerImportId,
    hostInitImportId,
    ssrRemotes,
  });
}

// Build-time remoteEntry only needs initResolve.
// It intentionally differs from the initPromise bootstrap so bundlers don't
// merge remoteEntry and loadShare onto the same shared runtime snippet.
export function getRuntimeInitResolveBootstrapCode(
  enableSsrInit = false,
  ownerImportId?: string,
  ssrRemotes?: Array<{ name: string; entry: string; type: string }>,
  hostInitImportId = ownerImportId
) {
  return getRuntimeInitStateBootstrapCode({
    globalKeyVar: '__mfResolveGlobalKey',
    stateVar: '__mfResolveState',
    exposedConst: 'initResolve',
    exposedProperty: 'initResolve',
    enableSsrInit,
    ownerImportId,
    hostInitImportId,
    ssrRemotes,
  });
}

export function writeRuntimeInitStatus(
  command: string,
  enableSsrInit = false,
  hostInitImportId?: string,
  options?: NormalizedModuleFederationOptions,
  ssrRemotes = _ssrRemotes
) {
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject, moduleCache } = globalThis[globalKey];
export { initPromise, initResolve, initReject, moduleCache };`
      : `module.exports = globalThis[globalKey];`;

  const ownerImportId = options ? getRuntimeInitStatusImportId(options) : hostInitImportId;
  getRuntimeInitModule(options).writeSync(`
${getRuntimeInitBootstrapCode(enableSsrInit, ownerImportId, ssrRemotes, hostInitImportId)}
${exportStatement}
`);
}
