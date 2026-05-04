import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getVirtualExposesSSRId } from './virtualExposesSSR';

const REMOTE_ENTRY_SSR_ID = 'virtual:mf-REMOTE_ENTRY_SSR_ID';

export function getRemoteEntrySSRId(
  options: Pick<NormalizedModuleFederationOptions, 'internalName' | 'filename'>
) {
  const scopedKey = `${options.internalName}__${options.filename}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${REMOTE_ENTRY_SSR_ID}:${scopedKey}`;
}

/**
 * SSR filename — the browser entry is e.g. "remoteEntry.js", the SSR entry
 * is e.g. "remoteEntry.server.js" (or .cjs for CJS output).
 */
export function getSSRFilename(browserFilename: string, isCJS: boolean): string {
  const ext = isCJS ? '.cjs' : '.js';
  const base = browserFilename.replace(/\.[^.]+$/, '');
  return `${base}.server${ext}`;
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

  return `
  import { init as runtimeInit } from "@module-federation/runtime";

  let exposesMapPromise;

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
      name: ${JSON.stringify(options.internalName)},
      remotes: [],
      shared: {},
    });
    const initToken = { from: ${JSON.stringify(options.internalName)} };
    if (initScope.indexOf(initToken) >= 0) return;
    initScope.push(initToken);
    initRes.initShareScopeMap(${JSON.stringify(options.shareScope)}, shared);
    try {
      await Promise.all(
        await initRes.initializeSharing(${JSON.stringify(options.shareScope)}, {
          strategy: ${JSON.stringify(options.shareStrategy ?? 'version-first')},
          from: 'build',
          initScope,
        })
      );
    } catch (e) {
      console.error('[Module Federation SSR]', e);
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
