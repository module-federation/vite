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
 *  - CJS entry (Vite 5–7 remotes): use `createRequire` to load it synchronously.
 *  - ESM entry (Vite 8+ remotes): use a dynamic `import()` — the SSR entry has
 *    no browser globals and all shared packages are external, so Node handles it
 *    natively without any experimental flags.
 *
 * Exported as a plain factory function so it can be serialised into the
 * generated runtimePlugins list in virtualRemotes.ts.
 */

// No static Node.js imports — this module is safe to import in the browser.
// Node APIs are loaded on demand via dynamic import() which is tree-shaken
// away when the caller is guarded by typeof window checks.
const importCache = new Map<string, Promise<unknown>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nodeImport(id: string): Promise<any> {
  if (!importCache.has(id)) importCache.set(id, import(/* @vite-ignore */ id));
  return importCache.get(id);
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

// Process-level cache: manifest URL → { ssrEntry URL, type }
const manifestCache = new Map<string, Promise<{ url: string; type: string } | null>>();

async function fetchManifest(manifestUrl: string): Promise<Manifest | null> {
  try {
    const res = await fetch(manifestUrl);
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

function getManifestUrl(remoteEntryUrl: string): string {
  return remoteEntryUrl.replace(/\/[^/]+$/, '/mf-manifest.json');
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
 * remoteEntry.js → remoteEntry.server.cjs  (Vite 5-7 CJS)
 * remoteEntry.js → remoteEntry.server.js   (Vite 8+ ESM)
 * Returns the first URL that responds with a 200.
 */
async function getSSREntryByConvention(
  remoteEntryUrl: string
): Promise<{ url: string; type: string } | null> {
  const base = remoteEntryUrl.replace(/\.[^.]+$/, '');
  const candidates = [
    { url: `${base}.server.cjs`, type: 'commonjs-module' },
    { url: `${base}.server.js`, type: 'module' },
  ];
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url, { method: 'HEAD' });
      const ct = res.headers.get('content-type') ?? '';
      // Reject SPA index.html fallbacks — only accept JS/text responses.
      if (res.ok && !ct.includes('text/html')) return candidate;
    } catch {
      // ignore — try next
    }
  }
  return null;
}

async function getSSREntry(remoteEntryUrl: string): Promise<{ url: string; type: string } | null> {
  const manifestUrl = getManifestUrl(remoteEntryUrl);
  if (!manifestCache.has(manifestUrl)) {
    manifestCache.set(
      manifestUrl,
      fetchManifest(manifestUrl).then(async (manifest) => {
        if (manifest) {
          const fromManifest = resolveSSREntryUrl(manifest, manifestUrl);
          if (fromManifest) return fromManifest;
        }
        // Manifest absent or has no ssrRemoteEntry — fall back to URL convention.
        return getSSREntryByConvention(remoteEntryUrl);
      })
    );
  }
  return manifestCache.get(manifestUrl)!;
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
  return code;
}

/**
 * Fetch an HTTP ESM module, transform it, write it to a temp .mjs file and
 * return the file path. Recursively does the same for HTTP transitive imports
 * so that `import('file:///...temp.mjs')` can resolve them.
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

    // Collect relative HTTP imports before transforming.
    const relImports: string[] = [];
    const relRegex =
      /(?:from|export\s*\*\s*from|import\s*\()\s*["'`](\.\.?\/[^"'`\s][^"'`]*)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = relRegex.exec(code)) !== null) {
      relImports.push(new URL(m[1], base).href);
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
    const tmpFile = join(tmpDir, `${hash}.mjs`);
    writeFileSync(tmpFile, code, 'utf8');
    visited.set(url, tmpFile);
    return tmpFile;
  })();

  tempFileCache.set(url, promise);
  return promise;
}

async function loadSSRRemoteEntry(ssrEntry: {
  url: string;
  type: string;
}): Promise<{ init: unknown; get: unknown } | null> {
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

  // ESM: if the URL is an http:// address, Node's native ESM loader can't
  // handle it without --experimental-network-imports. Fetch the source and
  // rewrite relative imports to absolute URLs, then load via data: URL.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const { mkdirSync } = await _fs();
    const { createRequire } = await _module();
    const cacheDir = await getSSRCacheDir();
    mkdirSync(cacheDir, { recursive: true });

    // Build a map of bare package specifier → absolute file path anchored to
    // the MF plugin's own location. Since the plugin lives in the host app's
    // node_modules (via the `ssrEntryLoader` subpath export), resolving from
    // import.meta.url walks up through the host's node_modules tree and finds
    // the same React version that the host's SSR runtime uses.
    const pluginRequire = createRequire(import.meta.url);
    const sharedPkgMap = new Map<string, string>();
    const commonShared = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'];
    for (const pkg of commonShared) {
      try {
        sharedPkgMap.set(pkg, pluginRequire.resolve(pkg));
      } catch {
        // Package not installed in the host app — skip.
      }
    }

    try {
      const tmpFile = await fetchEsmToTempFile(url, cacheDir, new Map(), sharedPkgMap);
      return (await import(tmpFile)) as { init: unknown; get: unknown };
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
// Default export so the module can be referenced as a runtimePlugin path string.
export default function ssrEntryLoaderPlugin() {
  return {
    name: 'mf-vite:ssr-entry-loader',
    async loadEntry({ remoteInfo }: { remoteInfo: RemoteInfo }) {
      // Only intercept on the server — browser should use the normal path.
      if (typeof (globalThis as any).window !== 'undefined') return;

      const ssrEntry = await getSSREntry(remoteInfo.entry);
      if (!ssrEntry) return;

      const mod = await loadSSRRemoteEntry(ssrEntry);
      if (!mod) return;

      return mod;
    },
  };
}
