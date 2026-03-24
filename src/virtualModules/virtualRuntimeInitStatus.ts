import VirtualModule from '../utils/VirtualModule';
import {
  getModuleFederationScopeKey,
  getNormalizeModuleFederationOptions,
  ModuleFederationScopeOptions,
} from '../utils/normalizeModuleFederationOptions';

const runtimeInitModules = new Map<string, VirtualModule>();

function resolveScopeOptions(options?: ModuleFederationScopeOptions): ModuleFederationScopeOptions {
  return options || getNormalizeModuleFederationOptions();
}

function getRuntimeInitModule(options?: ModuleFederationScopeOptions) {
  const resolvedOptions = resolveScopeOptions(options);
  const scopeKey = getModuleFederationScopeKey(resolvedOptions);
  let runtimeInitModule = runtimeInitModules.get(scopeKey);

  if (!runtimeInitModule) {
    runtimeInitModule = new VirtualModule('runtimeInit', '__mf_v__', '', {
      name: resolvedOptions.name,
      virtualModuleDir: resolvedOptions.virtualModuleDir,
    });
    runtimeInitModules.set(scopeKey, runtimeInitModule);
  }

  return runtimeInitModule;
}

export function getRuntimeInitGlobalKey(options?: ModuleFederationScopeOptions) {
  return `__mf_init__${getRuntimeInitModule(options).getImportId()}__`;
}

export function getRuntimeInitBootstrapCode(options?: ModuleFederationScopeOptions) {
  return `
const globalKey = ${JSON.stringify(getRuntimeInitGlobalKey(options))};
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
  };
  if (typeof window === 'undefined') {
    initResolve({
      loadRemote: function() { return Promise.resolve(undefined); },
      loadShare: function() { return Promise.resolve(undefined); },
    });
  }
}
`;
}

// Build-time shared/remotes shims only need initPromise.
// Keep this bootstrap text distinct from remoteEntry's initResolve bootstrap,
// otherwise Rolldown can dedupe them and recreate the loadShare deadlock.
export function getRuntimeInitPromiseBootstrapCode(options?: ModuleFederationScopeOptions) {
  return `
const __mfPromiseGlobalKey = ${JSON.stringify(getRuntimeInitGlobalKey(options))};
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
export function getRuntimeInitResolveBootstrapCode(options?: ModuleFederationScopeOptions) {
  return `
const __mfResolveGlobalKey = ${JSON.stringify(getRuntimeInitGlobalKey(options))};
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

export function writeRuntimeInitStatus(command: string, options?: ModuleFederationScopeOptions) {
  const globalKey = getRuntimeInitGlobalKey(options);
  const exportStatement =
    command === 'build'
      ? `const { initPromise, initResolve, initReject } = globalThis[globalKey];
export { initPromise, initResolve, initReject };`
      : `module.exports = globalThis[globalKey];`;

  getRuntimeInitModule(options).writeSync(
    `
${getRuntimeInitBootstrapCode(options)}
${exportStatement}
`,
    true
  );
}

export function getRuntimeInitImportId(command: string, options?: ModuleFederationScopeOptions) {
  writeRuntimeInitStatus(command, options);
  return getRuntimeInitModule(options).getImportId();
}
