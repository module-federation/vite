import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getVirtualExposesSSRId } from './virtualExposesSSR';
import { getVirtualModuleScopeKey } from './virtualModuleScope';
import { MODULE_CACHE_SHARE_SCOPE_KEY } from './virtualRuntimeInitStatus';

const REMOTE_ENTRY_SSR_ID = 'virtual:mf-REMOTE_ENTRY_SSR_ID';

export function getRemoteEntrySSRId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  return `${REMOTE_ENTRY_SSR_ID}:${getVirtualModuleScopeKey(options)}`;
}

export function getSsrRemoteEntryFileName(browserFilename: string): string {
  const ext = browserFilename.match(/\.[^.]+$/)?.[0] || '.js';
  const base = browserFilename.slice(0, browserFilename.length - ext.length);
  return `${base}.ssr${ext}`;
}

/**
 * Generates the SSR remote entry module.
 *
 * This is intentionally minimal — no HMR shim, no loadShare virtual modules,
 * no browser globals. Shared packages (react, react-dom, etc.) are imported
 * as externals by the SSR build, so Node's require cache provides the singleton.
 *
 * The container API (init / get) mirrors the browser entry so the MF runtime
 * can call it the same way on the server.
 */
export function generateRemoteEntrySSR(options: NormalizedModuleFederationOptions): string {
  const virtualExposesSSRId = getVirtualExposesSSRId(options);
  const sharedSingletons = Object.fromEntries(
    Object.entries(options.shared).filter(([, share]) => share.shareConfig.singleton)
  );

  return `
  import { init as runtimeInit } from "@module-federation/runtime";

  const sharedSingletons = ${JSON.stringify(sharedSingletons)};
  const moduleCacheKey = Symbol.for(${JSON.stringify(MODULE_CACHE_SHARE_SCOPE_KEY)});
  let exposesMapPromise;

  function createShareInitError(errors) {
    const details = errors.map(({ scopeName, pkg, error }) => {
      const target = pkg
        ? \`scope "\${scopeName}" package "\${pkg}"\`
        : \`scope "\${scopeName}"\`;
      return \`\${target}: \${error instanceof Error ? error.message : String(error)}\`;
    });
    const message = \`[Module Federation SSR] Shared initialization failed: \${details.join('; ')}\`;
    return new AggregateError(errors.map(({ error }) => error), message);
  }

  async function getExposesMap() {
    exposesMapPromise ??= import(${JSON.stringify(virtualExposesSSRId)}).then((mod) => mod.default ?? mod);
    return exposesMapPromise;
  }

  /**
   * Called by the MF runtime on the host to register this remote's share scope.
   * On the server the host has already initialised the runtime, so we just need
   * to set up a minimal runtime instance for the remote container.
   */
  async function init(shared = {}, initScope = []) {
    const initRes = runtimeInit({
      name: ${JSON.stringify(options.name)},
      remotes: [],
      shared: {},
    });
    const initToken = { from: ${JSON.stringify(options.name)} };
    if (initScope.indexOf(initToken) >= 0) return;
    initScope.push(initToken);
    const shareScopeNames = Array.isArray(${JSON.stringify(options.shareScope)})
      ? ${JSON.stringify(options.shareScope)}
      : [${JSON.stringify(options.shareScope)}];
    const shareInitErrors = [];
    const cacheEntries = [];
    for (const scopeName of shareScopeNames) {
      let scopeShare;
      try {
        scopeShare = Array.isArray(${JSON.stringify(options.shareScope)})
          ? shared?.[scopeName] || {}
          : shared || {};
        initRes.initShareScopeMap(scopeName, scopeShare);
        await Promise.all(
          await initRes.initializeSharing(scopeName, {
            strategy: ${JSON.stringify(options.shareStrategy ?? 'version-first')},
            from: 'build',
            initScope,
          })
        );
      } catch (e) {
        shareInitErrors.push({ scopeName, pkg: undefined, error: e });
        continue;
      }

      for (const [pkg, shareInfo] of Object.entries(sharedSingletons)) {
        try {
          if (shareInfo.scope !== scopeName) continue;
          if (!scopeShare[pkg]) continue;
          const factory = await initRes.loadShare(pkg, {
            customShareInfo: { ...shareInfo, scope: [scopeName] },
          });
          if (typeof factory !== 'function') {
            throw new Error('No compatible host provider was selected');
          }
          const module = await factory();
          cacheEntries.push({ scopeName, pkg, module });
        } catch (e) {
          shareInitErrors.push({ scopeName, pkg, error: e });
        }
      }
    }
    if (shareInitErrors.length > 0) {
      throw createShareInitError(shareInitErrors);
    }
    if (cacheEntries.length > 0) {
      const moduleCache = shared?.[moduleCacheKey] ||
        (globalThis.__mf_module_cache__ ||= { share: {}, remote: {} });
      const cache = (moduleCache.share ||= {});
      for (const { scopeName, pkg, module } of cacheEntries) {
        cache[scopeName + ':' + pkg] ??= module;
        if (scopeName === 'default') cache[pkg] ??= module;
      }
    }
    return initRes;
  }

  async function getExposes(moduleName) {
    const exposesMap = await getExposesMap();
    if (!(moduleName in exposesMap))
      throw new Error(\`[Module Federation] Module \${moduleName} does not exist in container.\`);
    return exposesMap[moduleName]().then((res) => () => res);
  }

  export { init, getExposes as get };
  `;
}
