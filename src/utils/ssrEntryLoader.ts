/**
 * MF runtime plugin that intercepts the `loadEntry` lifecycle hook on the
 * server and loads the SSR-compatible remote entry instead of the browser one.
 *
 * This completely replaces the need for any `@module-federation/sdk` patches.
 * The `loadEntry` hook is emitted by `runtime-core` before it falls through to
 * `loadScriptNode` — if the hook returns a value, the runtime uses it directly.
 *
 * Strategy:
 *  - In Node (detected through process.versions.node), fetch the remote's mf-manifest.json
 *    to discover the ssrRemoteEntry URL and its type.
 *  - ESM entry: use a dynamic `import()` — the SSR entry has no browser
 *    globals and all shared packages are external.
 *  - Dev mode (Vite 8+ only): use `ModuleRunner` with an HTTP transport backed
 *    by the remote's `/__mf_runner__` endpoint. This fetches fully-transformed
 *    module source through Vite's plugin pipeline, avoiding serialisation which
 *    cannot faithfully represent React components or closures.
 *
 *    Dev mode on Vite < 8 is NOT supported — `ModuleRunner` and
 *    `FetchableDevEnvironment` are Vite 8+ APIs. If you need dev-mode SSR on
 *    an older Vite version, implement an alternative loader in `loadSSRRemoteEntry`
 *    for the `isDevSsrEntry` branch and expose a corresponding server endpoint
 *    from `pluginSSRRemoteEntry.configureServer`.
 *
 * Exported as a plain factory function so it can be serialised into the
 * generated runtimePlugins list in virtualRemotes.ts.
 */

// No static Node.js imports — this module is safe to import in the browser.
// Node APIs are loaded on demand via dynamic import() which is tree-shaken
// away when the caller is guarded by a Node environment check.
const importCache = new Map<string, Promise<unknown>>();
async function nodeImport(id: string): Promise<unknown> {
  if (!importCache.has(id)) importCache.set(id, import(/* @vite-ignore */ id));
  return importCache.get(id);
}

// DOM shims can define window/document on the server. Node's version marker is
// not affected by those shims, and is absent in real browser environments.
const isNodeServer = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
  'string';

// ---------------------------------------------------------------------------
// Vite 8+ ModuleRunner path (dev mode only)
// ---------------------------------------------------------------------------

// Per-origin ModuleRunner instances — one per remote dev server.
// We cache them so repeated loadEntry calls reuse the same runner and its
// module evaluation cache, avoiding redundant HTTP round-trips.
const runnerCache = new Map<string, Promise<unknown>>();

/**
 * Import `vite/module-runner` dynamically. Returns null on Vite < 8 where the
 * subpath doesn't exist. Uses a plain dynamic import (not nodeImport) so that
 * Vitest can intercept it with vi.mock in tests.
 */
async function getModuleRunnerModule(): Promise<{
  ModuleRunner: new (
    opts: {
      hmr?: boolean;
      transport: {
        invoke: (payload: {
          type: string;
          event: string;
          data: { name: string; data: unknown[] };
        }) => Promise<{ result: unknown } | { error: { message: string } }>;
      };
    },
    evaluator?: unknown
  ) => { import: (id: string) => Promise<unknown> };
  ESModulesEvaluator: new () => unknown;
} | null> {
  try {
    // Dynamic import without @vite-ignore so Vitest can intercept via vi.mock.
    // This module is server-side only (guarded by window check in loadEntry)
    // so it's safe to import here without worrying about browser bundles.
    return (await import('vite/module-runner')) as Awaited<
      ReturnType<typeof getModuleRunnerModule>
    >;
  } catch {
    return null;
  }
}

/**
 * Create a ModuleRunner that fetches modules from a remote Vite dev server's
 * `/__mf_runner__` endpoint. Each HTTP POST carries a `fetchModule` invoke
 * payload; the remote responds with the transformed module source as JSON.
 *
 * This is Vite 8+ only — older versions don't expose `vite/module-runner` or
 * the `/__mf_runner__` proxy endpoint.
 */
async function getOrCreateRunner(remoteOrigin: string): Promise<unknown> {
  if (runnerCache.has(remoteOrigin)) return runnerCache.get(remoteOrigin)!;
  const promise = (async () => {
    const viteRunner = await getModuleRunnerModule();
    if (!viteRunner) return null;
    const { ModuleRunner, ESModulesEvaluator } = viteRunner;
    const runnerEndpoint = `${remoteOrigin}/__mf_runner__`;
    try {
      const runner = new ModuleRunner(
        {
          // HMR requires a persistent connection (WebSocket); our HTTP transport
          // is request/response only so HMR must be disabled.
          hmr: false,
          transport: {
            async invoke(payload) {
              const res = await fetch(runnerEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              });
              return (await res.json()) as { result: unknown } | { error: { message: string } };
            },
          },
        },
        new ESModulesEvaluator()
      );
      return runner;
    } catch {
      return null;
    }
  })();
  runnerCache.set(remoteOrigin, promise);
  return promise;
}

const _path = () => nodeImport('path') as Promise<typeof import('path')>;
const _fs = () => nodeImport('fs') as Promise<typeof import('fs')>;
const _crypto = () => nodeImport('crypto') as Promise<typeof import('crypto')>;
const _module = () => nodeImport('module') as Promise<typeof import('module')>;

// RemoteInfo mirrors the shape from @module-federation/runtime-core so the
// loadEntry hook is compatible with the runtime's lifecycle signature.
interface RemoteInfo {
  name: string;
  entry: string;
  type?: string;
  entryGlobalName?: string;
}

interface ManifestMetaData {
  ssrRemoteEntry?: { name: string; path: string; type: string };
  remoteEntry?: { name: string; path: string; type: string };
  buildInfo?: { buildVersion?: string };
  publicPath?: string;
  getPublicPath?: string;
}

interface Manifest {
  metaData?: ManifestMetaData;
}

/**
 * Version key for a resolved SSR entry. Derived from the remote's manifest
 * content so a redeploy at the same URL produces a different key, which in
 * turn produces different temp-file names — busting both our caches and
 * Node's ESM module cache. Convention-resolved entries (no manifest) get a
 * stable placeholder key and cannot be revalidated automatically.
 */
const UNVERSIONED = 'unversioned';

// FNV-1a — cheap, dependency-free, stable across processes. Not cryptographic;
// only used to key caches and temp file names.
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function computeManifestVersionKey(manifest: Manifest): string {
  const buildVersion = manifest.metaData?.buildInfo?.buildVersion;
  const contentHash = hashString(JSON.stringify(manifest));
  return buildVersion ? `${buildVersion}-${contentHash}` : contentHash;
}

interface SsrEntryCacheRecord {
  promise: Promise<SsrEntryCandidate | null>;
  resolvedAt: number;
}

// Process-level cache: remote entry URL → resolved SSR entry (+ resolution time
// so `maxAgeMs` can trigger revalidation against the remote's manifest).
const ssrEntryCache = new Map<string, SsrEntryCacheRecord>();
// Dedupe manifest fetches when multiple entry URLs resolve to the same manifest.
const manifestFetchCache = new Map<string, Promise<Manifest | null>>();

interface EntryContext {
  entryUrl: string;
  manifestUrl: string;
  manifest: Manifest | null;
  assetBaseUrl: string;
  filename: string;
  remoteOrigin: string;
}

interface SsrEntryCandidate {
  url: string;
  type: string;
  versionKey: string;
}

export class SsrEntryHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
    readonly bodyPreview: string
  ) {
    super(
      `Failed to fetch SSR module "${url}": ${status} ${statusText}` +
        (bodyPreview ? `\npreview: ${bodyPreview}` : '')
    );
    this.name = 'SsrEntryHttpError';
  }
}

function getBodyPreview(body: string): string {
  return body.slice(0, 240).replace(/\s+/g, ' ').trim();
}

function isSsrEntryHttpError(error: unknown): error is SsrEntryHttpError {
  return error instanceof SsrEntryHttpError;
}

async function fetchManifest(manifestUrl: string): Promise<Manifest | null> {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

async function fetchManifestCached(manifestUrl: string): Promise<Manifest | null> {
  if (!manifestFetchCache.has(manifestUrl)) {
    manifestFetchCache.set(manifestUrl, fetchManifest(manifestUrl));
  }
  return manifestFetchCache.get(manifestUrl)!;
}

/** True when the host configured a manifest URL as the remote entry (any .json name). */
function isManifestEntry(remoteEntryUrl: string): boolean {
  try {
    const { pathname } = new URL(remoteEntryUrl);
    return /\.json$/i.test(pathname);
  } catch {
    return /\.json(?:[?#]|$)/i.test(remoteEntryUrl);
  }
}

function isSsrEntry(remoteEntryUrl: string): boolean {
  return /\.ssr\.js(?:[?#].*)?$/.test(remoteEntryUrl);
}

function getManifestUrl(remoteEntryUrl: string): string {
  if (isManifestEntry(remoteEntryUrl)) return remoteEntryUrl;
  return remoteEntryUrl.replace(/\/[^/]+$/, '/mf-manifest.json');
}

function getEntryFilename(entryUrl: string): string {
  return (
    entryUrl
      .split('/')
      .pop()
      ?.replace(/[?#].*$/, '')
      .replace(/\.[^.]+$/, '') ?? 'remoteEntry'
  );
}

function resolveEntryAssetUrl(entry: { name: string; path?: string }, manifestUrl: string): string {
  const base = manifestUrl.replace(/\/[^/]+$/, '/');
  return new URL(`${entry.path || ''}${entry.name}`, base).href;
}

function resolveSSREntryUrl(manifest: Manifest, manifestUrl: string): SsrEntryCandidate | null {
  const meta = manifest?.metaData;
  if (!meta?.ssrRemoteEntry?.name) return null;

  const base = manifestUrl.replace(/\/[^/]+$/, '/');
  const entryPath = (meta.ssrRemoteEntry.path || '') + meta.ssrRemoteEntry.name;
  const url = new URL(entryPath, base).href;
  return {
    url,
    type: meta.ssrRemoteEntry.type || 'module',
    versionKey: computeManifestVersionKey(manifest),
  };
}

/**
 * Derive the SSR entry URL by convention when no manifest is available.
 * remoteEntry.js → remoteEntry.ssr.js
 * remoteEntry.js → /__mf_ssr__/remoteEntry.ssr.js (dev middleware)
 * Returns the first URL that responds with a 200.
 */
async function headCheckSsrEntry(candidate: SsrEntryCandidate): Promise<SsrEntryCandidate | null> {
  try {
    const res = await fetch(candidate.url, { method: 'HEAD' });
    const ct = res.headers.get('content-type') ?? '';
    // Reject SPA index.html fallbacks — only accept JS/text responses.
    if (res.ok && !ct.includes('text/html')) return candidate;
  } catch {
    // ignore
  }
  return null;
}

function resolveAssetBaseUrl(
  entryUrl: string,
  manifest: Manifest | null,
  manifestUrl: string
): string {
  const remoteEntry = manifest?.metaData?.remoteEntry;
  if (remoteEntry?.name) return resolveEntryAssetUrl(remoteEntry, manifestUrl);
  if (!isManifestEntry(entryUrl)) return entryUrl;
  return new URL('remoteEntry.js', manifestUrl.replace(/\/[^/]+$/, '/')).href;
}

async function buildEntryContext(entryUrl: string): Promise<EntryContext> {
  const manifestUrl = getManifestUrl(entryUrl);
  const manifest = await fetchManifestCached(manifestUrl);
  const assetBaseUrl = resolveAssetBaseUrl(entryUrl, manifest, manifestUrl);
  const filename = getEntryFilename(assetBaseUrl);
  const remoteOrigin = assetBaseUrl.replace(/\/[^/]+$/, '');

  return { entryUrl, manifestUrl, manifest, assetBaseUrl, filename, remoteOrigin };
}

function buildSsrEntryCandidates(
  ctx: EntryContext,
  options: { skipServerBuild?: boolean } = {}
): SsrEntryCandidate[] {
  const { assetBaseUrl, filename, remoteOrigin } = ctx;
  const base = assetBaseUrl.replace(/\.[^.]+$/, '');
  const candidates: SsrEntryCandidate[] = [];

  if (!options.skipServerBuild) {
    candidates.push({
      url: `${remoteOrigin}/__mf_server__/${filename}.ssr.js`,
      type: 'module',
      versionKey: UNVERSIONED,
    });
  }

  candidates.push(
    { url: `${base}.ssr.js`, type: 'module', versionKey: UNVERSIONED },
    {
      url: `${remoteOrigin}/__mf_ssr__/${filename}.ssr.js`,
      type: 'module',
      versionKey: UNVERSIONED,
    }
  );

  return candidates;
}

async function resolveFirstReachableCandidate(
  candidates: SsrEntryCandidate[]
): Promise<SsrEntryCandidate | null> {
  for (const candidate of candidates) {
    const hit = await headCheckSsrEntry(candidate);
    if (hit) return hit;
  }
  return null;
}

async function resolveSSREntryImpl(remoteEntryUrl: string): Promise<SsrEntryCandidate | null> {
  if (isSsrEntry(remoteEntryUrl)) {
    return { url: remoteEntryUrl, type: 'module', versionKey: UNVERSIONED };
  }

  // For JS entries, probe the dedicated server build before fetching the manifest.
  if (!isManifestEntry(remoteEntryUrl)) {
    const filename = getEntryFilename(remoteEntryUrl);
    const remoteOrigin = remoteEntryUrl.replace(/\/[^/]+$/, '');
    const fromServerBuild = await headCheckSsrEntry({
      url: `${remoteOrigin}/__mf_server__/${filename}.ssr.js`,
      type: 'module',
      versionKey: UNVERSIONED,
    });
    if (fromServerBuild) return fromServerBuild;
  }

  const ctx = await buildEntryContext(remoteEntryUrl);
  if (ctx.manifest) {
    const fromManifest = resolveSSREntryUrl(ctx.manifest, ctx.manifestUrl);
    if (fromManifest) return fromManifest;
  }
  return resolveFirstReachableCandidate(
    buildSsrEntryCandidates(ctx, { skipServerBuild: !isManifestEntry(remoteEntryUrl) })
  );
}

function setSsrEntryCache(remoteEntryUrl: string): SsrEntryCacheRecord {
  const record: SsrEntryCacheRecord = {
    promise: resolveSSREntryImpl(remoteEntryUrl),
    resolvedAt: Date.now(),
  };
  ssrEntryCache.set(remoteEntryUrl, record);
  return record;
}

async function getSSREntry(
  remoteEntryUrl: string,
  maxAgeMs?: number
): Promise<SsrEntryCandidate | null> {
  const cached = ssrEntryCache.get(remoteEntryUrl);
  if (!cached) return setSsrEntryCache(remoteEntryUrl).promise;

  const isStale =
    typeof maxAgeMs === 'number' && maxAgeMs >= 0 && Date.now() - cached.resolvedAt >= maxAgeMs;
  if (!isStale) return cached.promise;

  // Stale: re-fetch the manifest and re-resolve. If the version key changed
  // (remote redeployed at the same URL), the new key flows into temp-file
  // names, so the fresh entry is imported instead of Node's cached module.
  const previous = await cached.promise.catch(() => null);
  manifestFetchCache.delete(getManifestUrl(remoteEntryUrl));
  const record = setSsrEntryCache(remoteEntryUrl);
  const next = await record.promise.catch(() => null);

  if (previous && next && previous.versionKey !== next.versionKey) {
    dropRemoteCaches(remoteEntryUrl);
  }
  return record.promise;
}

/**
 * Drop per-remote caches after a version change so old artifacts stop being
 * reused. Temp-file cache keys hold SSR entry/chunk URLs (not the browser
 * entry URL), so scope the invalidation by origin.
 */
function dropRemoteCaches(remoteEntryUrl: string): void {
  let origin: string;
  try {
    origin = new URL(remoteEntryUrl).origin;
  } catch {
    return;
  }
  for (const key of tempFileCache.keys()) {
    const url = key.slice(key.indexOf('::') + 2);
    if (url.startsWith(origin)) tempFileCache.delete(key);
  }
}

/**
 * Drop the loader's caches so the next `loadEntry` re-resolves and re-fetches
 * remote SSR entries. Pass a remote entry URL to scope the invalidation to one
 * remote; call with no arguments to invalidate everything.
 *
 * Note: the MF runtime keeps its own container/module caches per federation
 * instance. This function best-effort clears the module caches of all global
 * federation instances so re-renders load fresh remote modules, but hosts that
 * hold direct references to previously loaded modules keep those references.
 */
export function revalidate(remoteEntryUrl?: string): void {
  if (remoteEntryUrl) {
    ssrEntryCache.delete(remoteEntryUrl);
    manifestFetchCache.delete(getManifestUrl(remoteEntryUrl));
    dropRemoteCaches(remoteEntryUrl);
  } else {
    ssrEntryCache.clear();
    manifestFetchCache.clear();
    tempFileCache.clear();
  }

  const federation = (
    globalThis as {
      __FEDERATION__?: { __INSTANCES__?: Array<{ moduleCache?: Map<string, unknown> }> };
    }
  ).__FEDERATION__;
  for (const instance of federation?.__INSTANCES__ ?? []) {
    try {
      instance?.moduleCache?.clear?.();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Recursive HTTP → temp-file fetcher
// ---------------------------------------------------------------------------

const tempFileCache = new Map<string, Promise<string>>();

// Lazily initialised on the server only — avoids evaluating Node APIs in browser.
let ssrCacheDirPromise: Promise<string> | undefined;
async function getSSRCacheDir(): Promise<string> {
  if (!ssrCacheDirPromise) {
    ssrCacheDirPromise = (async () => {
      const { join } = await _path();
      const { rmSync } = await _fs();
      // Use process.cwd() (the running app's root) rather than the plugin
      // file's directory. This ensures bare specifier resolution in temp files
      // walks up from the app root and finds the correct node_modules — the
      // plugin may be bundled deep in .output/server/_libs/ which can resolve
      // to a different (hoisted) version of shared packages like react.
      const dir = join(process.cwd(), 'node_modules', '.ssr-cache');
      // Clean up temp files on process exit to avoid accumulation.
      process.once('exit', () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
      return dir;
    })();
  }
  return ssrCacheDirPromise;
}

/**
 * Neutralize browser-only preload machinery in Vite/Rolldown output so the
 * code can evaluate in Node. Shared by the temp-file and vm strategies.
 */
export function neutralizeBrowserPreloadHelpers(code: string): string {
  // Replace Vite's preload-helper (uses document) with a server no-op,
  // preserving the local binding name so call-sites still work.
  code = code.replace(
    /import\s*\{([^}]*)\}\s*from\s*["'][^"']*preload-helper[^"']*["'];?/g,
    (_m, bindings: string) => {
      const locals = bindings
        .split(',')
        .map((b) => {
          const parts = b.trim().split(/\s+as\s+/);
          return (parts[1] ?? parts[0]).trim();
        })
        .filter(Boolean);
      return locals.map((l) => `const ${l} = (fn) => fn();`).join('\n');
    }
  );
  code = code.replace(/__vite__mapDeps\([^)]+\)/g, '[]');
  // Rolldown can inline Vite's preload helper instead of importing
  // preload-helper. Its error path dispatches `vite:preloadError` on window,
  // which is invalid while Node imports remote SSR temp files. Replace calls
  // to helpers that wrap dynamic imports with the wrapped import itself.
  code = code.replace(
    /\b([A-Za-z_$][\w$]*)\s*\(\s*\(\s*\)\s*=>\s*import\(([^)]*)\)\s*,\s*\[\]\s*\)/g,
    'import($2)'
  );
  return code;
}

function transformSsrCode(code: string, base: string, sharedPkgMap?: Map<string, string>): string {
  // Rewrite relative specifiers to absolute HTTP URLs.
  code = code.replace(
    /((?:from|export\s*\*\s*from)\s*)(["'`])(\.\.?\/[^"'`\s][^"'`]*)["'`]/g,
    (_m, prefix, _q, specifier) => `${prefix}"${new URL(specifier, base).href}"`
  );
  code = code.replace(
    /(import\s*)(["'`])(\.\.?\/[^"'`\s][^"'`]*)["'`]/g,
    (_m, prefix, _q, specifier) => `${prefix}"${new URL(specifier, base).href}"`
  );
  code = code.replace(
    /(import\s*\(\s*)(["'`])(\.\.?\/[^"'`\s][^"'`]*)["'`](\s*\))/g,
    (_m, prefix, _q, specifier, suffix) => `${prefix}"${new URL(specifier, base).href}"${suffix}`
  );
  // Rewrite bare shared package specifiers to absolute file:// paths so all
  // temp-file modules use the same physical module instance as the host app.
  // Without this, Node resolves bare "react" from the workspace root which
  // may be a different version than the one bundled into the host's server.
  if (sharedPkgMap && sharedPkgMap.size > 0) {
    code = code.replace(
      /(?:from|import\s*\()\s*(["'`])([^"'`./][^"'`]*)["'`]/g,
      (m, _q, specifier) => {
        const resolved = sharedPkgMap.get(specifier);
        return resolved ? m.replace(specifier, `file://${resolved}`) : m;
      }
    );
  }
  return neutralizeBrowserPreloadHelpers(code);
}

function isVitePreloadHelperSpecifier(specifier: string): boolean {
  return specifier.includes('preload-helper');
}

/**
 * Fetch an HTTP ESM module, transform it, write it to a temp .js file and
 * return the file path. Recursively does the same for HTTP transitive imports
 * so that `import('file:///...temp.js')` can resolve them.
 *
 * `versionKey` participates in both the cache key and the temp file name, so
 * a remote redeploy (new manifest → new key) produces new files and bypasses
 * Node's ESM module cache instead of serving the stale build.
 */
async function fetchEsmToTempFile(
  url: string,
  tmpDir: string,
  visited: Map<string, string>,
  sharedPkgMap?: Map<string, string>,
  versionKey: string = UNVERSIONED
): Promise<string> {
  const cacheKey = `${versionKey}::${url}`;
  if (visited.has(url)) return visited.get(url)!;
  if (tempFileCache.has(cacheKey)) return tempFileCache.get(cacheKey)!;

  const promise = (async () => {
    const res = await fetch(url);
    let code = await res.text();
    if (!res.ok) {
      throw new SsrEntryHttpError(url, res.status, res.statusText, getBodyPreview(code));
    }

    const base = url.replace(/\/[^/]*$/, '/');

    // Collect relative HTTP imports before transforming. Keep this pattern
    // broad enough for nested import() call-sites generated by Vite/Rolldown.
    const relImports: string[] = [];
    const relRegex = /(?:from|export\s*\*\s*from|import\s*(?:\(|\s))\s*["'`]([^"'`\s]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = relRegex.exec(code)) !== null) {
      if (
        (m[1].startsWith('./') || m[1].startsWith('../')) &&
        !isVitePreloadHelperSpecifier(m[1])
      ) {
        relImports.push(new URL(m[1], base).href);
      }
    }

    // Recursively fetch transitive HTTP imports and collect their temp paths.
    const subMap = new Map<string, string>();
    await Promise.all(
      [...new Set(relImports)]
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'))
        .map(async (u) => {
          const tmpPath = await fetchEsmToTempFile(u, tmpDir, visited, sharedPkgMap, versionKey);
          subMap.set(u, `file://${tmpPath}`);
        })
    );

    // Transform code: absolute HTTP URLs → file:// paths for temp files,
    // and bare shared package specifiers → absolute file:// paths.
    code = transformSsrCode(code, base, sharedPkgMap);
    for (const [httpUrl, fileUrl] of subMap) {
      code = code.split(httpUrl).join(fileUrl);
    }

    const { createHash } = await _crypto();
    const { join } = await _path();
    const { writeFileSync } = await _fs();
    const hash = createHash('sha1').update(cacheKey).digest('hex').slice(0, 12);
    const tmpFile = join(tmpDir, `${hash}.js`);
    writeFileSync(tmpFile, code, 'utf8');
    visited.set(url, tmpFile);
    return tmpFile;
  })();

  tempFileCache.set(cacheKey, promise);
  return promise;
}

async function importTempModule(
  filePath: string,
  versionKey: string
): Promise<{ init: unknown; get: unknown }> {
  // The version query busts Node's ESM module cache (and any stale resolution
  // state) when a remote redeploys: same temp path + new version → fresh module.
  const specifier = `${filePath}?v=${encodeURIComponent(versionKey)}`;
  return (await import(/* @vite-ignore */ specifier)) as { init: unknown; get: unknown };
}

let warnedVmUnavailable = false;

async function tryVmStrategy(
  ssrEntry: SsrEntryCandidate,
  options: ResolvedLoaderOptions
): Promise<{ init: unknown; get: unknown } | null> {
  const { loadViaVmStrategy, isVmStrategyAvailable } = await import('./ssrVmStrategy');

  if (!(await isVmStrategyAvailable())) {
    if (!warnedVmUnavailable) {
      warnedVmUnavailable = true;
      console.warn(
        '[mf-vite:ssr-entry-loader] strategy "vm" requires vm.SourceTextModule ' +
          '(run Node with --experimental-vm-modules); falling back to the temp-file strategy.'
      );
    }
    return null;
  }

  return (await loadViaVmStrategy(ssrEntry.url, {
    resolvedShared: options.resolvedShared,
    shareScopeName: options.shareScopeName,
    versionKey: ssrEntry.versionKey,
  })) as { init: unknown; get: unknown } | null;
}

async function loadSSRRemoteEntry(
  ssrEntry: SsrEntryCandidate,
  options: ResolvedLoaderOptions
): Promise<{ init: unknown; get: unknown } | null> {
  const { url, type, versionKey } = ssrEntry;
  const { resolvedShared } = options;

  if (type === 'commonjs-module' || type === 'commonjs') {
    // CJS: use createRequire so we get the same Node module-cache singleton
    // as react-dom/server (guarantees the React instance is shared).
    const { createRequire } = await _module();
    const req = createRequire(import.meta.url);
    try {
      return req(url) as { init: unknown; get: unknown };
    } catch {
      // URL may be http — createRequire only handles file paths.
      // Fall through to dynamic import for http CJS (rare case).
    }
  }

  // Vite 8+ dev-mode path: when the URL points to the dev server's
  // `/__mf_ssr__/` endpoint, use a ModuleRunner backed by an HTTP transport
  // that fetches fully-transformed module source from `/__mf_runner__`.
  // This is the correct mechanism for dev mode — it avoids serialisation
  // (which breaks React components) and gives us real Vite-transformed modules.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const urlObj = new URL(url);
    const isDevSsrEntry = urlObj.pathname.includes('/__mf_ssr__/');
    if (isDevSsrEntry) {
      // Dev-mode SSR is Vite 8+ only. `pluginSSRRemoteEntry` registers a
      // `resolveId` hook that maps `/__mf_ssr__/<filename>.ssr.js` to the
      // virtual SSR entry ID, so `runner.import()` traverses the full Vite
      // plugin pipeline and returns real, fully-transformed module source.
      const remoteOrigin = urlObj.origin;
      const runner = await getOrCreateRunner(remoteOrigin);
      if (!runner) {
        if (process.env.NODE_ENV !== 'production') return null;
      } else {
        try {
          const mod = await (runner as { import: (id: string) => Promise<unknown> }).import(
            urlObj.pathname
          );
          if (mod && typeof mod === 'object' && 'init' in mod) {
            return mod as { init: unknown; get: unknown };
          }
          if (process.env.NODE_ENV !== 'production') return null;
        } catch {
          if (process.env.NODE_ENV !== 'production') return null;
        }
      }
    }

    // Opt-in vm.SourceTextModule strategy: evaluates the remote's ESM graph in
    // the current context and links bare shared imports through the host's
    // federation share scope (true version negotiation) instead of rewriting
    // them to file:// paths. Falls back to the temp-file strategy when the
    // SourceTextModule API is unavailable or evaluation fails.
    if (options.strategy === 'vm') {
      try {
        const fromVm = await tryVmStrategy(ssrEntry, options);
        if (fromVm) return fromVm;
      } catch (error) {
        if (isSsrEntryHttpError(error)) throw error;
        // fall through to the temp-file strategy
      }
    }

    // Production build HTTP entries: fetch source and write to temp file so
    // Node can import it via file:// URL (avoids --experimental-network-imports).
    // Production previews may also mount built SSR assets under /__mf_ssr__/
    // without exposing the dev-only ModuleRunner endpoint, so they fall through here.
    const { mkdirSync } = await _fs();
    const cacheDir = await getSSRCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // resolvedShared is pre-populated at build time by the Vite plugin from
    // the MF plugin's own installed location, making resolution package-
    // manager-agnostic. We use it directly here — no runtime createRequire
    // walk-up needed.
    const sharedPkgMap = new Map(Object.entries(resolvedShared));

    try {
      const tmpFile = await fetchEsmToTempFile(url, cacheDir, new Map(), sharedPkgMap, versionKey);
      return await importTempModule(tmpFile, versionKey);
    } catch (error) {
      if (isSsrEntryHttpError(error)) throw error;
      return null;
    }
  }

  try {
    return (await import(/* @vite-ignore */ url)) as { init: unknown; get: unknown };
  } catch {
    return null;
  }
}

/**
 * MF runtime plugin factory.
 *
 * Usage in runtimePlugins:
 *   import { ssrEntryLoaderPlugin } from '@module-federation/vite/ssrEntryLoader'
 *   federation({ runtimePlugins: [ssrEntryLoaderPlugin] })
 *
 * The plugin is also injected automatically for SSR contexts by the vite plugin.
 */
interface SsrEntryLoaderOptions {
  /**
   * Pre-resolved absolute file paths for common shared packages, keyed by
   * bare specifier. Populated at build time by the Vite plugin from the MF
   * plugin's own installed location so the resolution is package-manager-
   * agnostic. ssrEntryLoader uses these directly when rewriting bare specifiers
   * in remote SSR entry temp files — no runtime createRequire walk-up needed.
   */
  resolvedShared?: Record<string, string>;
  /**
   * How to evaluate remote SSR entries on the server.
   *
   * - `'temp-file'` (default): fetch the ESM graph, rewrite specifiers, write
   *   temp files and `import()` them. Works on stock Node; shared packages are
   *   pinned to the host's copies via `resolvedShared` (no version negotiation).
   * - `'vm'`: evaluate the graph with `vm.SourceTextModule` and link bare
   *   shared imports through the host's federation share scope (`loadShare`),
   *   restoring version negotiation. Requires `--experimental-vm-modules`;
   *   falls back to `'temp-file'` when unavailable.
   */
  strategy?: 'temp-file' | 'vm';
  /**
   * Share scope consulted by the `'vm'` strategy when linking bare imports.
   * Defaults to `'default'`.
   */
  shareScopeName?: string;
  /**
   * Re-check each remote's manifest when the cached SSR entry resolution is
   * older than this many milliseconds. When the manifest's version changes
   * (remote redeployed at the same URL), the loader drops its caches for that
   * remote so subsequent loads use the new build. Omit to cache until process
   * exit or an explicit `revalidate()` call. Only manifest-resolved entries
   * can be revalidated this way — convention-resolved entries have no version
   * source.
   */
  maxAgeMs?: number;
}

interface ResolvedLoaderOptions {
  resolvedShared: Record<string, string>;
  strategy: 'temp-file' | 'vm';
  shareScopeName: string;
  maxAgeMs?: number;
}

// Default export so the module can be referenced as a runtimePlugin path string.
export default function ssrEntryLoaderPlugin(options: SsrEntryLoaderOptions = {}) {
  const resolved: ResolvedLoaderOptions = {
    resolvedShared: options.resolvedShared ?? {},
    strategy: options.strategy ?? 'temp-file',
    shareScopeName: options.shareScopeName ?? 'default',
    maxAgeMs: options.maxAgeMs,
  };
  return {
    name: 'mf-vite:ssr-entry-loader',
    async loadEntry({ remoteInfo }: { remoteInfo: RemoteInfo }) {
      // Only intercept on the server — browser should use the normal path.
      if (!isNodeServer()) return;

      const ssrEntry = await getSSREntry(remoteInfo.entry, resolved.maxAgeMs);
      if (!ssrEntry) return;

      const mod = await loadSSRRemoteEntry(ssrEntry, resolved);
      if (!mod) return;

      return mod;
    },
  };
}
