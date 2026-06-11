/**
 * MF runtime plugin that intercepts the `loadEntry` lifecycle hook on the
 * server and loads the SSR-compatible remote entry instead of the browser one.
 *
 * This completely replaces the need for any `@module-federation/sdk` patches.
 * The `loadEntry` hook is emitted by `runtime-core` before it falls through to
 * `loadScriptNode` — if the hook returns a value, the runtime uses it directly.
 *
 * Strategy:
 *  - In Node (typeof window === 'undefined'), fetch the remote's mf-manifest.json
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
// away when the caller is guarded by typeof window checks.
const importCache = new Map<string, Promise<unknown>>();
async function nodeImport(id: string): Promise<unknown> {
  if (!importCache.has(id)) importCache.set(id, import(/* @vite-ignore */ id));
  return importCache.get(id);
}

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
                body: JSON.stringify({ name: payload.data.name, data: payload.data.data }),
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
  publicPath?: string;
  getPublicPath?: string;
}

interface Manifest {
  metaData?: ManifestMetaData;
}

// Process-level cache: remote entry URL → resolved SSR entry
const ssrEntryCache = new Map<string, Promise<{ url: string; type: string } | null>>();

async function fetchManifest(manifestUrl: string): Promise<Manifest | null> {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

function isManifestEntry(remoteEntryUrl: string): boolean {
  return /\.json(?:[?#].*)?$/.test(remoteEntryUrl);
}

function isSsrEntry(remoteEntryUrl: string): boolean {
  return /\.ssr\.js(?:[?#].*)?$/.test(remoteEntryUrl);
}

function getManifestUrl(remoteEntryUrl: string): string {
  if (isManifestEntry(remoteEntryUrl)) return remoteEntryUrl;
  return remoteEntryUrl.replace(/\/[^/]+$/, '/mf-manifest.json');
}

function getEntryFilename(remoteEntryUrl: string): string {
  return (
    remoteEntryUrl
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

function resolveSSREntryUrl(
  manifest: Manifest,
  manifestUrl: string
): { url: string; type: string } | null {
  const meta = manifest?.metaData;
  if (!meta?.ssrRemoteEntry?.name) return null;

  const base = manifestUrl.replace(/\/[^/]+$/, '/');
  const entryPath = (meta.ssrRemoteEntry.path || '') + meta.ssrRemoteEntry.name;
  const url = new URL(entryPath, base).href;
  return { url, type: meta.ssrRemoteEntry.type || 'module' };
}

/**
 * Derive the SSR entry URL by convention when no manifest is available.
 * remoteEntry.js → remoteEntry.ssr.js
 * remoteEntry.js → /__mf_ssr__/remoteEntry.ssr.js (dev middleware)
 * Returns the first URL that responds with a 200.
 */
async function headCheckSsrEntry(candidate: {
  url: string;
  type: string;
}): Promise<{ url: string; type: string } | null> {
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

async function resolveSSREntryFromManifest(
  manifest: Manifest,
  manifestUrl: string,
  remoteEntryUrl: string
): Promise<{ url: string; type: string } | null> {
  const fromManifest = resolveSSREntryUrl(manifest, manifestUrl);
  if (fromManifest) {
    const hit = await headCheckSsrEntry(fromManifest);
    if (hit) return hit;
  }

  const remoteEntryName = manifest.metaData?.remoteEntry?.name;
  if (remoteEntryName) {
    const remoteEntry = manifest.metaData!.remoteEntry!;
    const entryBaseUrl = resolveEntryAssetUrl(remoteEntry, manifestUrl);
    const remoteOrigin = entryBaseUrl.replace(/\/[^/]+$/, '');
    const filename = getEntryFilename(entryBaseUrl);
    const fromServerBuild = await headCheckSsrEntry({
      url: `${remoteOrigin}/__mf_server__/${filename}.ssr.js`,
      type: 'module',
    });
    if (fromServerBuild) return fromServerBuild;
    return getSSREntryByConvention(remoteEntryUrl, {
      skipServerBuild: true,
      filename,
      entryBaseUrl,
    });
  }
  return null;
}

async function getSSREntryByConvention(
  remoteEntryUrl: string,
  options: { skipServerBuild?: boolean; filename?: string; entryBaseUrl?: string } = {}
): Promise<{ url: string; type: string } | null> {
  const entryBaseUrl = options.entryBaseUrl ?? remoteEntryUrl;
  const base = entryBaseUrl.replace(/\.[^.]+$/, '');
  const remoteOrigin = entryBaseUrl.replace(/\/[^/]+$/, '');
  const filename = options.filename ?? getEntryFilename(entryBaseUrl);
  const candidates = [
    // SSR graph from a dedicated server build (Environment API or `vite build --ssr`).
    // Must be tried before the client-emitted .ssr.js entry, which pulls browser
    // loadRemote chunks and can recurse indefinitely for nested remotes.
    ...(options.skipServerBuild
      ? []
      : [{ url: `${remoteOrigin}/__mf_server__/${filename}.ssr.js`, type: 'module' as const }]),
    { url: `${base}.ssr.js`, type: 'module' },
    { url: `${remoteOrigin}/__mf_ssr__/${filename}.ssr.js`, type: 'module' },
  ];
  for (const candidate of candidates) {
    const hit = await headCheckSsrEntry(candidate);
    if (hit) return hit;
  }
  return null;
}

async function resolveSSREntryImpl(
  remoteEntryUrl: string
): Promise<{ url: string; type: string } | null> {
  if (isSsrEntry(remoteEntryUrl)) {
    const hit = await headCheckSsrEntry({ url: remoteEntryUrl, type: 'module' });
    if (hit) return hit;
  }

  const manifestUrl = getManifestUrl(remoteEntryUrl);
  if (isManifestEntry(remoteEntryUrl)) {
    const manifest = await fetchManifest(manifestUrl);
    if (manifest) {
      const fromManifest = await resolveSSREntryFromManifest(manifest, manifestUrl, remoteEntryUrl);
      if (fromManifest) return fromManifest;
    }
    return getSSREntryByConvention(remoteEntryUrl, { skipServerBuild: true });
  }

  const remoteOrigin = remoteEntryUrl.replace(/\/[^/]+$/, '');
  const filename = getEntryFilename(remoteEntryUrl);

  // Prefer a server-build SSR entry when the remote serves dist/server (preview/production).
  const fromServerBuild = await headCheckSsrEntry({
    url: `${remoteOrigin}/__mf_server__/${filename}.ssr.js`,
    type: 'module',
  });
  if (fromServerBuild) return fromServerBuild;

  const manifest = await fetchManifest(manifestUrl);
  if (manifest) {
    const fromManifest = await resolveSSREntryFromManifest(manifest, manifestUrl, remoteEntryUrl);
    if (fromManifest) return fromManifest;
  }
  // Manifest absent or has no ssrRemoteEntry — fall back to URL convention.
  return getSSREntryByConvention(remoteEntryUrl, { skipServerBuild: true });
}

async function getSSREntry(remoteEntryUrl: string): Promise<{ url: string; type: string } | null> {
  if (!ssrEntryCache.has(remoteEntryUrl)) {
    ssrEntryCache.set(remoteEntryUrl, resolveSSREntryImpl(remoteEntryUrl));
  }
  return ssrEntryCache.get(remoteEntryUrl)!;
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

/**
 * Fetch an HTTP ESM module, transform it, write it to a temp .js file and
 * return the file path. Recursively does the same for HTTP transitive imports
 * so that `import('file:///...temp.js')` can resolve them.
 */
async function fetchEsmToTempFile(
  url: string,
  tmpDir: string,
  visited: Map<string, string>,
  sharedPkgMap?: Map<string, string>
): Promise<string> {
  if (visited.has(url)) return visited.get(url)!;
  if (tempFileCache.has(url)) return tempFileCache.get(url)!;

  const promise = (async () => {
    const res = await fetch(url);
    let code = await res.text();
    const base = url.replace(/\/[^/]*$/, '/');

    // Collect relative HTTP imports before transforming. Keep this pattern
    // broad enough for nested import() call-sites generated by Vite/Rolldown.
    const relImports: string[] = [];
    const relRegex = /(?:from|export\s*\*\s*from|import\s*(?:\(|\s))\s*["'`]([^"'`\s]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = relRegex.exec(code)) !== null) {
      if (m[1].startsWith('./') || m[1].startsWith('../')) {
        relImports.push(new URL(m[1], base).href);
      }
    }

    // Recursively fetch transitive HTTP imports and collect their temp paths.
    const subMap = new Map<string, string>();
    await Promise.all(
      [...new Set(relImports)]
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'))
        .map(async (u) => {
          const tmpPath = await fetchEsmToTempFile(u, tmpDir, visited, sharedPkgMap);
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
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const tmpFile = join(tmpDir, `${hash}.js`);
    writeFileSync(tmpFile, code, 'utf8');
    visited.set(url, tmpFile);
    return tmpFile;
  })();

  tempFileCache.set(url, promise);
  return promise;
}

async function importTempModule(filePath: string): Promise<{ init: unknown; get: unknown }> {
  return (await import(/* @vite-ignore */ filePath)) as { init: unknown; get: unknown };
}

async function loadSSRRemoteEntry(
  ssrEntry: { url: string; type: string },
  resolvedShared: Record<string, string> = {}
): Promise<{ init: unknown; get: unknown } | null> {
  const { url, type } = ssrEntry;

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
      //
      // Vite < 8 falls through here with runner === null. Rather than attempting
      // a broken fallback (fetchEsmToTempFile can't serialise React components),
      // we return null so the MF runtime falls back to client-only rendering.
      // To add Vite < 8 dev-mode support, implement an alternative loader here
      // and expose a corresponding endpoint from pluginSSRRemoteEntry.configureServer.
      const remoteOrigin = urlObj.origin;
      const runner = await getOrCreateRunner(remoteOrigin);
      if (!runner) return null;
      try {
        const mod = await (runner as { import: (id: string) => Promise<unknown> }).import(
          urlObj.pathname
        );
        return mod as { init: unknown; get: unknown };
      } catch {
        return null;
      }
    }

    // Production build HTTP entries: fetch source and write to temp file so
    // Node can import it via file:// URL (avoids --experimental-network-imports).
    const { mkdirSync } = await _fs();
    const cacheDir = await getSSRCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // resolvedShared is pre-populated at build time by the Vite plugin from
    // the MF plugin's own installed location, making resolution package-
    // manager-agnostic. We use it directly here — no runtime createRequire
    // walk-up needed.
    const sharedPkgMap = new Map(Object.entries(resolvedShared));

    try {
      const tmpFile = await fetchEsmToTempFile(url, cacheDir, new Map(), sharedPkgMap);
      return await importTempModule(tmpFile);
    } catch {
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
}

// Default export so the module can be referenced as a runtimePlugin path string.
export default function ssrEntryLoaderPlugin(options: SsrEntryLoaderOptions = {}) {
  const resolvedShared = options.resolvedShared ?? {};
  return {
    name: 'mf-vite:ssr-entry-loader',
    async loadEntry({ remoteInfo }: { remoteInfo: RemoteInfo }) {
      // Only intercept on the server — browser should use the normal path.
      if (typeof (globalThis as Record<string, unknown>).window !== 'undefined') return;

      const ssrEntry = await getSSREntry(remoteInfo.entry);
      if (!ssrEntry) return;

      const mod = await loadSSRRemoteEntry(ssrEntry, resolvedShared);
      if (!mod) return;

      return mod;
    },
  };
}
