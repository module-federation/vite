import {
  NormalizedModuleFederationOptions,
  ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import { getVirtualExposesSSRId } from './virtualExposesSSR';
import { expandSharedPrefixKey, getUsedShares } from './virtualRemoteEntry';
import { getVirtualModuleScopeKey } from './virtualModuleScope';
import { MODULE_CACHE_SHARE_SCOPE_KEY } from './virtualRuntimeInitStatus';

const REMOTE_ENTRY_SSR_ID = 'virtual:mf-REMOTE_ENTRY_SSR_ID';

export function getRemoteEntrySSRId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  return `${REMOTE_ENTRY_SSR_ID}:${getVirtualModuleScopeKey(options)}`;
}

function stripSsrFilenameHashPlaceholder(filename: string): string {
  // Strip literal `[hash]` / `[hash:N]` placeholders so SSR companions stay
  // stable (`remoteEntry-[hash].js` → `remoteEntry.js`). Do not try to mirror
  // the browser content hash in the SSR filename.
  if (!filename.includes('[hash')) return filename;
  filename = filename.replace(/(?:[._-]?\[hash(?::\d+)?\])/g, '');
  if (!/\.[^.]+$/.test(filename)) {
    filename = `${filename}.js`;
  }
  return filename;
}

export function getSsrRemoteEntryFileName(browserFilename: string): string {
  const filename = stripSsrFilenameHashPlaceholder(browserFilename);
  const ext = filename.match(/\.[^.]+$/)?.[0] || '.js';
  const base = filename.slice(0, filename.length - ext.length);
  return `${base}.ssr${ext}`;
}

export function getSsrExposesFileName(browserFilename: string): string {
  const filename = stripSsrFilenameHashPlaceholder(browserFilename);
  const ext = filename.match(/\.[^.]+$/)?.[0];
  const base = ext ? filename.slice(0, filename.length - ext.length) : filename;
  return `${base}.exposes.js`;
}

/** Singleton map for SSR loadShare: expand `pkg/` via usedShares; never serialize the prefix. */
function getSsrSharedSingletons(
  options: NormalizedModuleFederationOptions
): Record<string, ShareItem> {
  const used = getUsedShares(options);
  const result: Record<string, ShareItem> = {};

  for (const [pkg, share] of Object.entries(options.shared)) {
    if (!share.shareConfig.singleton) continue;
    if (pkg.endsWith('/')) {
      for (const concrete of expandSharedPrefixKey(pkg, used)) {
        result[concrete] = { ...share, name: concrete };
      }
      continue;
    }
    result[pkg] = share;
  }

  return result;
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
  const sharedSingletons = getSsrSharedSingletons(options);

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
