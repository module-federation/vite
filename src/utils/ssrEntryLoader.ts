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
 *    Dev mode on Vite < 8 is NOT supported by this integration because the
 *    cross-process `fetchModule` proxy uses Vite 8's environment APIs.
 *    `ModuleRunner` itself is available in earlier Vite versions, but an older
 *    remote needs a different transport and server endpoint.
 *
 * Exported as a plain factory function so it can be serialised into the
 * generated runtimePlugins list in virtualRemotes.ts.
 */

import { simpleJoinRemoteEntry } from '@module-federation/sdk';
import {
  DEFAULT_SSR_FETCH_MAX_BYTES,
  DEFAULT_SSR_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  isSsrFetchBodyTooLargeError,
  readResponseTextBounded,
} from './fetchWithTimeout';
import { EXTERNAL_URL_RE } from './buildPaths';
import { createCodePositionMap } from './codePositionMap';
import { CodeRewriter } from './codeRewriter';
import { mfWarn } from './logger';
import type { SsrEntryLoaderConfig } from './normalizeModuleFederationOptions';
import { getUrlOrigin } from './url';

// No static Node.js imports — this module is safe to import in the browser.
// Node APIs are loaded on demand via dynamic import() which is tree-shaken
// away when the caller is guarded by a Node environment check.
const importCache = new Map<string, Promise<unknown>>();
async function nodeImport(id: string): Promise<unknown> {
  if (!importCache.has(id)) importCache.set(id, import(/* @vite-ignore */ id));
  return importCache.get(id);
}

// Detect whether loadEntry should intercept browser remote loading for SSR.
// Prefer Vite's realm-specific flag; fall back for direct, untransformed Node usage.
const isNodeServer = (): boolean => {
  const viteSsr = (import.meta as ImportMeta & { env?: { SSR?: boolean } }).env?.SSR;
  return (
    viteSsr ??
    typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
      ?.node === 'string'
  );
};

// ---------------------------------------------------------------------------
// Vite 8+ ModuleRunner path (dev mode only)
// ---------------------------------------------------------------------------

// Per-origin ModuleRunner instances — one per remote dev server and host
// shared-module map. The transport closes over resolvedShared, so different
// hosts (or federation instances) must not reuse a runner configured for
// another host's filesystem.
type CachedModuleRunner = {
  import: (id: string) => Promise<unknown>;
  clearCache?: () => void;
};

const runnerCache = new Map<
  string,
  { remoteOrigin: string; promise: Promise<CachedModuleRunner | null> }
>();

function getSortedRecordEntries(record: Record<string, string>): [string, string][] {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Load `vite/module-runner`. Returns null when the installed Vite does not
 * expose the module-runner entry point.
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
  ) => CachedModuleRunner;
  ESModulesEvaluator: new () => unknown;
} | null> {
  const moduleRunnerId = ['vite', 'module-runner'].join('/');
  // Prefer Node's loader. When this plugin itself runs inside another Vite
  // ModuleRunner (for example Vinext RSC), a regular import lets the host
  // transform Vite's own module-runner and breaks its internal import(filepath).
  try {
    const { createRequire } = (await nodeImport('module')) as typeof import('module');
    const require = createRequire(import.meta.url);
    return require(moduleRunnerId) as Awaited<ReturnType<typeof getModuleRunnerModule>>;
  } catch {
    // Retain an ESM fallback for releases which cannot be required and tests.
  }
  try {
    return (await nodeImport(moduleRunnerId)) as Awaited<ReturnType<typeof getModuleRunnerModule>>;
  } catch {
    return null;
  }
}

/**
 * Create a ModuleRunner that fetches modules from a remote Vite dev server's
 * `/__mf_runner__` endpoint. Each HTTP POST carries a `fetchModule` invoke
 * payload; the remote responds with the transformed module source as JSON.
 *
 * The cross-process transport is Vite 8+ only because older versions do not
 * expose the `/__mf_runner__` environment proxy used here.
 */
function getRunnerCacheKey(
  remoteOrigin: string,
  resolvedShared: Record<string, string>,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): string {
  return JSON.stringify([
    remoteOrigin,
    fetchTimeoutMs,
    fetchMaxBytes,
    getSortedRecordEntries(resolvedShared),
  ]);
}

async function resolveSharedExternal(
  id: unknown,
  resolvedShared: Record<string, string>
): Promise<{ externalize: string; type: 'module' } | null> {
  if (typeof id !== 'string') return null;
  const resolved = resolvedShared[id];
  if (!resolved) return null;

  if (EXTERNAL_URL_RE.test(resolved)) {
    return { externalize: resolved, type: 'module' };
  }

  const { pathToFileURL } = await _url();
  return { externalize: pathToFileURL(resolved).href, type: 'module' };
}

async function getOrCreateRunner(
  remoteOrigin: string,
  resolvedShared: Record<string, string>,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): Promise<unknown> {
  const cacheKey = getRunnerCacheKey(remoteOrigin, resolvedShared, fetchTimeoutMs, fetchMaxBytes);
  const cached = runnerCache.get(cacheKey);
  if (cached) return cached.promise;
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
              const res = await fetchWithTimeout(
                runnerEndpoint,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                },
                fetchTimeoutMs
              );
              const text = await readResponseTextBounded(res, fetchMaxBytes, runnerEndpoint);
              const result = parseRunnerInvokeResult(JSON.parse(text));
              // Let the remote transform configured shares and resolve local-only
              // dependencies first. This preserves remote-owned React islands.
              if ('error' in result && payload.data.name === 'fetchModule') {
                const sharedExternal = await resolveSharedExternal(
                  payload.data.data[0],
                  resolvedShared
                );
                if (sharedExternal) return { result: sharedExternal };
              }
              return result;
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
  runnerCache.set(cacheKey, { remoteOrigin, promise });
  return promise;
}

const _path = () => nodeImport('path') as Promise<typeof import('path')>;
const _fs = () => nodeImport('fs') as Promise<typeof import('fs')>;
const _crypto = () => nodeImport('crypto') as Promise<typeof import('crypto')>;
const _module = () => nodeImport('module') as Promise<typeof import('module')>;
const _url = () => nodeImport('url') as Promise<typeof import('url')>;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseManifestEntry(
  value: unknown
): { name: string; path: string; type: string } | undefined {
  if (!isPlainObject(value) || typeof value.name !== 'string' || value.name.length === 0) {
    return undefined;
  }
  return {
    name: value.name,
    path: typeof value.path === 'string' ? value.path : '',
    type: typeof value.type === 'string' ? value.type : 'module',
  };
}

/** Network JSON is untyped until parsed. Keep the original object for version hashing. */
function parseManifest(data: unknown): Manifest | null {
  if (!isPlainObject(data)) return null;
  return data as Manifest;
}

function parseRunnerInvokeResult(
  data: unknown
): { result: unknown } | { error: { message: string } } {
  if (!isPlainObject(data)) {
    return { error: { message: 'Invalid runner response' } };
  }
  if ('error' in data) {
    const error = data.error;
    const message =
      isPlainObject(error) && typeof error.message === 'string'
        ? error.message
        : 'Unknown runner error';
    return { error: { message } };
  }
  if ('result' in data) return { result: data.result };
  return { result: data };
}

/**
 * Version key for a resolved SSR entry. Derived from the remote's manifest
 * content so a redeploy at the same URL produces a different key, which in
 * turn produces different temp-file names — busting both our caches and
 * Node's ESM module cache. Convention-resolved entries (no manifest) use a
 * stable placeholder key for ordinary loads; explicit `revalidate()` calls
 * advance a process-local generation so the next import is fresh.
 */
const UNVERSIONED = 'unversioned';
const unversionedGenerations = new Map<string, number>();
let unversionedGlobalGeneration = 0;

function getUnversionedVersionKey(remoteEntryUrl: string): string {
  return `${UNVERSIONED}-${unversionedGlobalGeneration}-${unversionedGenerations.get(remoteEntryUrl) ?? 0}`;
}

function bumpUnversionedGeneration(remoteEntryUrl: string): void {
  unversionedGenerations.set(remoteEntryUrl, (unversionedGenerations.get(remoteEntryUrl) ?? 0) + 1);
}

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

function makeUrlCacheKey(url: string, fetchTimeoutMs: number, fetchMaxBytes: number): string {
  return `${fetchTimeoutMs}::${fetchMaxBytes}::${url}`;
}

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

async function fetchManifest(
  manifestUrl: string,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): Promise<Manifest | null> {
  try {
    const res = await fetchWithTimeout(manifestUrl, {}, fetchTimeoutMs);
    if (!res.ok) return null;
    const text = await readResponseTextBounded(res, fetchMaxBytes, manifestUrl);
    return parseManifest(JSON.parse(text));
  } catch (error) {
    // Size-limit failures must fail closed; other discovery errors stay soft.
    if (isSsrFetchBodyTooLargeError(error)) throw error;
    return null;
  }
}

async function fetchManifestCached(
  manifestUrl: string,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): Promise<Manifest | null> {
  const cacheKey = makeUrlCacheKey(manifestUrl, fetchTimeoutMs, fetchMaxBytes);
  if (!manifestFetchCache.has(cacheKey)) {
    const promise = fetchManifest(manifestUrl, fetchTimeoutMs, fetchMaxBytes);
    manifestFetchCache.set(cacheKey, promise);
    void promise.then(
      (manifest) => {
        if (!manifest && manifestFetchCache.get(cacheKey) === promise) {
          manifestFetchCache.delete(cacheKey);
        }
      },
      () => {
        if (manifestFetchCache.get(cacheKey) === promise) {
          manifestFetchCache.delete(cacheKey);
        }
      }
    );
  }
  return manifestFetchCache.get(cacheKey)!;
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
  return new URL(simpleJoinRemoteEntry(entry.path || '', entry.name), base).href;
}

function resolveSSREntryUrl(manifest: Manifest, manifestUrl: string): SsrEntryCandidate | null {
  const entry = parseManifestEntry(manifest.metaData?.ssrRemoteEntry);
  if (!entry) return null;

  const base = manifestUrl.replace(/\/[^/]+$/, '/');
  const url = new URL(simpleJoinRemoteEntry(entry.path, entry.name), base).href;
  return {
    url,
    type: entry.type,
    versionKey: computeManifestVersionKey(manifest),
  };
}

/**
 * Derive the SSR entry URL by convention when no manifest is available.
 * remoteEntry.js → remoteEntry.ssr.js
 * remoteEntry.js → /__mf_ssr__/remoteEntry.ssr.js (dev middleware)
 * Returns the first URL that responds with a 200.
 */
async function headCheckSsrEntry(
  candidate: SsrEntryCandidate,
  fetchTimeoutMs: number
): Promise<SsrEntryCandidate | null> {
  try {
    const res = await fetchWithTimeout(candidate.url, { method: 'HEAD' }, fetchTimeoutMs);
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
  const remoteEntry = parseManifestEntry(manifest?.metaData?.remoteEntry);
  if (remoteEntry) return resolveEntryAssetUrl(remoteEntry, manifestUrl);
  if (!isManifestEntry(entryUrl)) return entryUrl;
  return new URL('remoteEntry.js', manifestUrl.replace(/\/[^/]+$/, '/')).href;
}

async function buildEntryContext(
  entryUrl: string,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): Promise<EntryContext> {
  const manifestUrl = getManifestUrl(entryUrl);
  const manifest = await fetchManifestCached(manifestUrl, fetchTimeoutMs, fetchMaxBytes);
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
      versionKey: getUnversionedVersionKey(ctx.entryUrl),
    });
  }

  candidates.push(
    {
      url: `${base}.ssr.js`,
      type: 'module',
      versionKey: getUnversionedVersionKey(ctx.entryUrl),
    },
    {
      url: `${remoteOrigin}/__mf_ssr__/${filename}.ssr.js`,
      type: 'module',
      versionKey: getUnversionedVersionKey(ctx.entryUrl),
    }
  );

  return candidates;
}

async function resolveFirstReachableCandidate(
  candidates: SsrEntryCandidate[],
  fetchTimeoutMs: number
): Promise<SsrEntryCandidate | null> {
  for (const candidate of candidates) {
    const hit = await headCheckSsrEntry(candidate, fetchTimeoutMs);
    if (hit) return hit;
  }
  return null;
}

async function resolveSSREntryImpl(
  remoteEntryUrl: string,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): Promise<SsrEntryCandidate | null> {
  if (isSsrEntry(remoteEntryUrl)) {
    return {
      url: remoteEntryUrl,
      type: 'module',
      versionKey: getUnversionedVersionKey(remoteEntryUrl),
    };
  }

  // For JS entries, probe the dedicated server build before fetching the manifest.
  if (!isManifestEntry(remoteEntryUrl)) {
    const filename = getEntryFilename(remoteEntryUrl);
    const remoteOrigin = remoteEntryUrl.replace(/\/[^/]+$/, '');
    const fromServerBuild = await headCheckSsrEntry(
      {
        url: `${remoteOrigin}/__mf_server__/${filename}.ssr.js`,
        type: 'module',
        versionKey: getUnversionedVersionKey(remoteEntryUrl),
      },
      fetchTimeoutMs
    );
    if (fromServerBuild) return fromServerBuild;
  }

  const ctx = await buildEntryContext(remoteEntryUrl, fetchTimeoutMs, fetchMaxBytes);
  if (ctx.manifest) {
    const fromManifest = resolveSSREntryUrl(ctx.manifest, ctx.manifestUrl);
    if (fromManifest) return fromManifest;
  }
  return resolveFirstReachableCandidate(
    buildSsrEntryCandidates(ctx, { skipServerBuild: !isManifestEntry(remoteEntryUrl) }),
    fetchTimeoutMs
  );
}

function setSsrEntryCache(
  remoteEntryUrl: string,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): SsrEntryCacheRecord {
  const cacheKey = makeUrlCacheKey(remoteEntryUrl, fetchTimeoutMs, fetchMaxBytes);
  const record: SsrEntryCacheRecord = {
    promise: resolveSSREntryImpl(remoteEntryUrl, fetchTimeoutMs, fetchMaxBytes),
    resolvedAt: Date.now(),
  };
  ssrEntryCache.set(cacheKey, record);
  void record.promise.then(
    (entry) => {
      if (!entry && ssrEntryCache.get(cacheKey) === record) ssrEntryCache.delete(cacheKey);
    },
    () => {
      if (ssrEntryCache.get(cacheKey) === record) ssrEntryCache.delete(cacheKey);
    }
  );
  return record;
}

async function getSSREntry(
  remoteEntryUrl: string,
  maxAgeMs: number | undefined,
  fetchTimeoutMs: number,
  fetchMaxBytes: number
): Promise<SsrEntryCandidate | null> {
  const cacheKey = makeUrlCacheKey(remoteEntryUrl, fetchTimeoutMs, fetchMaxBytes);
  const cached = ssrEntryCache.get(cacheKey);
  if (!cached) return setSsrEntryCache(remoteEntryUrl, fetchTimeoutMs, fetchMaxBytes).promise;

  const isStale =
    typeof maxAgeMs === 'number' && maxAgeMs >= 0 && Date.now() - cached.resolvedAt >= maxAgeMs;
  if (!isStale) return cached.promise;

  // Stale: re-fetch the manifest and re-resolve. If the version key changed
  // (remote redeployed at the same URL), the new key flows into temp-file
  // names and the ModuleRunner cache is cleared, so the fresh entry is
  // imported instead of a cached module.
  const previous = await cached.promise.catch(() => null);
  manifestFetchCache.delete(
    makeUrlCacheKey(getManifestUrl(remoteEntryUrl), fetchTimeoutMs, fetchMaxBytes)
  );
  const record = setSsrEntryCache(remoteEntryUrl, fetchTimeoutMs, fetchMaxBytes);
  const next = await record.promise.catch(() => null);

  if (previous && next && previous.versionKey !== next.versionKey) {
    await invalidateRemoteCaches(remoteEntryUrl);
  }
  return record.promise;
}

/**
 * Drop a remote graph's temp-file caches after a version change so old
 * artifacts stop being reused. A generated module can be shared by multiple
 * remote graphs, so cleanup is scoped by graph owner rather than URL origin.
 */
function dropRemoteTempFileCaches(remoteEntryUrl: string): void {
  const staleRecords: TempFileRecord[] = [];
  for (const [key, record] of tempFileRecords) {
    if (!record.owners.delete(remoteEntryUrl) || record.owners.size > 0) continue;

    tempFileCache.delete(key);
    tempFilePathCache.delete(key);
    staleRecords.push(record);
  }
  scheduleTempFileCleanup(staleRecords);
}

/**
 * Invalidate all SSR loader caches owned by a remote. The runtime loading map
 * is cleared synchronously so `revalidate()` can safely clear module caches
 * immediately after invoking this function.
 */
function invalidateRemoteCaches(remoteEntryUrl: string): Promise<void> {
  invalidateRuntimeRemoteEntry(remoteEntryUrl);
  dropRemoteTempFileCaches(remoteEntryUrl);
  scheduleVmCacheCleanup(remoteEntryUrl);
  return clearRunnerCaches(remoteEntryUrl);
}

/**
 * The VM strategy owns separate in-memory module-graph caches. Keep their
 * invalidation aligned with the temp-file and ModuleRunner caches without a
 * static import cycle between the two SSR strategies.
 */
function scheduleVmCacheCleanup(remoteEntryUrl?: string): void {
  if (!vmStrategyModulePromise) return;
  void vmStrategyModulePromise
    .then(({ clearVmStrategyCaches }) => clearVmStrategyCaches(remoteEntryUrl))
    .catch(() => {
      // VM cache cleanup is best-effort, like temp-file cleanup.
    });
}

/**
 * A dev-mode ModuleRunner is created per origin (one Vite dev server) and is
 * shared by every remote that server hosts, so its module cache can only be
 * cleared as a whole. Origin scoping is therefore the finest granularity here;
 * clearing only costs a re-evaluation, no generated files are removed.
 */
async function clearRunnerCaches(remoteEntryUrl?: string): Promise<void> {
  let remoteOrigin: string | undefined;
  if (remoteEntryUrl) {
    remoteOrigin = getUrlOrigin(remoteEntryUrl);
    if (!remoteOrigin) return;
  }

  await Promise.all(
    [...runnerCache.values()]
      .filter((cached) => !remoteOrigin || cached.remoteOrigin === remoteOrigin)
      .map(async (cached) => {
        try {
          (await cached.promise)?.clearCache?.();
        } catch {
          // A failed runner must not prevent another runner from being cleared.
        }
      })
  );
}

/** Invalidate all SSR loader caches across every remote. */
function invalidateAllRemoteCaches(): void {
  invalidateRuntimeRemoteEntry();
  const staleRecords = [...tempFileRecords.values()];
  for (const record of staleRecords) record.owners.clear();
  tempFileCache.clear();
  tempFilePathCache.clear();
  scheduleTempFileCleanup(staleRecords);
  scheduleVmCacheCleanup();
  void clearRunnerCaches();
}

/**
 * runtime-core deduplicates remote entry loads in a process-global map. The
 * SSR loader's module cache invalidation must evict the matching runtime entry
 * too, otherwise the next loadRemote() returns the pre-revalidation container
 * without invoking this loader again.
 */
function invalidateRuntimeRemoteEntry(remoteEntryUrl?: string): void {
  const global = globalThis as typeof globalThis & {
    __GLOBAL_LOADING_REMOTE_ENTRY__?: Record<string, unknown>;
  };
  const globalLoading = global.__GLOBAL_LOADING_REMOTE_ENTRY__;
  if (!globalLoading) return;

  for (const key of Object.keys(globalLoading)) {
    if (
      remoteEntryUrl === undefined ||
      key === remoteEntryUrl ||
      key.endsWith(`:${remoteEntryUrl}`)
    ) {
      delete globalLoading[key];
    }
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
    bumpUnversionedGeneration(remoteEntryUrl);
    for (const key of ssrEntryCache.keys()) {
      if (key.endsWith(`::${remoteEntryUrl}`)) ssrEntryCache.delete(key);
    }
    const manifestUrl = getManifestUrl(remoteEntryUrl);
    for (const key of manifestFetchCache.keys()) {
      if (key.endsWith(`::${manifestUrl}`)) manifestFetchCache.delete(key);
    }
    void invalidateRemoteCaches(remoteEntryUrl);
  } else {
    unversionedGlobalGeneration += 1;
    ssrEntryCache.clear();
    manifestFetchCache.clear();
    invalidateAllRemoteCaches();
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
const tempFilePathCache = new Map<string, Promise<string>>();
const TEMP_FILE_CLEANUP_DELAY_MS = 30_000;

type TempFileRecord = {
  cacheKey: string;
  filePathPromise: Promise<string>;
  promise: Promise<string>;
  owners: Set<string>;
};

// Keep generated files independent from the in-memory cache so invalidation can
// retire the files that belonged to an old remote generation as well.
const tempFileRecords = new Map<string, TempFileRecord>();
const scheduledTempFileCleanup = new Set<string>();

function scheduleTempFileCleanup(records: TempFileRecord[]): void {
  for (const record of records) {
    if (scheduledTempFileCleanup.has(record.cacheKey)) continue;
    scheduledTempFileCleanup.add(record.cacheKey);

    const timer = setTimeout(() => {
      void cleanupTempFileRecord(record);
    }, TEMP_FILE_CLEANUP_DELAY_MS);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  }
}

async function cleanupTempFileRecord(record: TempFileRecord): Promise<void> {
  try {
    // A revalidation can race an in-flight graph fetch. Wait for the writer so
    // it cannot recreate an orphaned file after cleanup has already run.
    await record.promise.catch(() => undefined);
    // A shared transitive module can belong to more than one remote graph. A
    // scoped revalidation retires only one owner; keep the file while another
    // remote can still resolve it from its active generation.
    if (record.owners.size > 0) return;
    // An explicit revalidate can resolve to the same manifest version and
    // therefore reuse the same cache key/path. Do not let an older cleanup
    // task remove the newer record's file.
    if (tempFileRecords.get(record.cacheKey) !== record) return;
    const filePath = await record.filePathPromise;
    const { rmSync } = await _fs();
    rmSync(filePath, { force: true });
  } catch {
    // Cleanup is best-effort; the next process-exit cleanup remains the final
    // backstop for files that cannot be removed here.
  } finally {
    if (tempFileRecords.get(record.cacheKey) === record) {
      tempFileRecords.delete(record.cacheKey);
    }
    scheduledTempFileCleanup.delete(record.cacheKey);
  }
}

// Temp dir + transform context → `node:module` shim file URL (see getRequireShimUrl).
const requireShimCache = new Map<string, Promise<string>>();

/**
 * `resolvedShared` rewrites import/export specifiers only. Bundled CommonJS in a
 * remote requires shared packages through `createRequire(import.meta.url)` —
 * Rolldown's `__require("react")` — and Node resolves those from the temp dir,
 * which can reach another copy than the pinned one. Remote modules importing
 * `node:module` get this shim instead: its `createRequire` resolves pinned
 * specifiers to the same files the rewritten imports load.
 */
function createRequireShimSource(sharedPkgMap: Map<string, string>): string {
  return [
    "import * as nodeModule from 'node:module';",
    "export * from 'node:module';",
    'export default nodeModule.default;',
    `const pinned = new Map(${JSON.stringify([...sharedPkgMap])});`,
    "const pin = (id) => (typeof id === 'string' && pinned.get(id)) || id;",
    'export function createRequire(filename) {',
    '  const require = nodeModule.createRequire(filename);',
    '  const resolve = (id, options) => require.resolve(pin(id), options);',
    '  resolve.paths = require.resolve.paths;',
    '  return Object.assign((id) => require(pin(id)), require, { resolve });',
    '}',
    '',
  ].join('\n');
}

function getRequireShimUrl(
  tmpDir: string,
  sharedPkgMap: Map<string, string>,
  contextKey: string
): Promise<string> {
  const cacheKey = JSON.stringify([tmpDir, contextKey]);
  const cached = requireShimCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const { join } = await _path();
    const { writeFileSync } = await _fs();
    const file = join(tmpDir, `node-module-${hashString(contextKey)}.mjs`);
    writeFileSync(file, createRequireShimSource(sharedPkgMap), 'utf8');
    return `file://${file}`;
  })();
  requireShimCache.set(cacheKey, promise);
  void promise.catch(() => {
    if (requireShimCache.get(cacheKey) === promise) requireShimCache.delete(cacheKey);
  });
  return promise;
}

function getSsrTransformContextKey(
  resolvedShared: Record<string, string>,
  shareScopeName: string
): string {
  return JSON.stringify([shareScopeName, getSortedRecordEntries(resolvedShared)]);
}

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
      // Keep each Node process in its own directory so one process cannot
      // remove another process's in-flight or cached SSR modules on exit.
      const dir = join(process.cwd(), 'node_modules', '.ssr-cache', String(process.pid));
      // Clean up this process's temp files on exit to avoid accumulation.
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

interface SsrModuleSpecifier {
  /** Range of the quoted string literal, quotes included. */
  start: number;
  end: number;
  value: string;
}

// `from "x"`, `export * from "x"`, `import "x"` and `import("x")`.
const SSR_MODULE_SPECIFIER_RE =
  /(?:from|export\s*\*\s*from|import\s*\(?\s*)\s*(["'`])([^"'`\s]+)\1/g;

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Module specifiers used by the import/export syntax of `code`. Import-like
 * text inside comments and string literals (JSDoc such as
 * `@type {import('./x')}`, docs, error messages) is skipped, and a comment
 * between `import(` and the specifier (webpack-style magic comments) does not
 * hide a real dynamic import. Discovery and rewriting both read this list, so
 * they always agree on which specifiers exist.
 */
function findSsrModuleSpecifiers(code: string): SsrModuleSpecifier[] {
  let blanked = '';
  let blankedUntil = 0;
  const isCode = createCodePositionMap(code, (start, end) => {
    blanked += code.slice(blankedUntil, start) + ' '.repeat(end - start);
    blankedUntil = end;
  });
  blanked += code.slice(blankedUntil);

  const specifiers: SsrModuleSpecifier[] = [];
  for (const match of blanked.matchAll(SSR_MODULE_SPECIFIER_RE)) {
    // The keyword itself must be code, not text inside a string literal.
    if (!isCode[match.index]) continue;
    const end = match.index + match[0].length;
    const value = match[2];
    specifiers.push({ start: end - value.length - 2, end, value });
  }
  return specifiers;
}

function isNodeModuleSpecifier(specifier: string): boolean {
  return specifier === 'node:module' || specifier === 'module';
}

function transformSsrCode(
  code: string,
  base: string,
  specifiers: SsrModuleSpecifier[],
  sharedPkgMap?: Map<string, string>,
  requireShimUrl?: string,
  tempFileUrlMap?: Map<string, string>
): string {
  const rewriter = new CodeRewriter(code);
  for (const { start, end, value } of specifiers) {
    if (requireShimUrl && isNodeModuleSpecifier(value)) {
      rewriter.overwrite(start, end, `"${requireShimUrl}"`);
      continue;
    }
    // Relative specifiers become absolute HTTP URLs. Bare shared package
    // specifiers become absolute file:// paths so all temp-file modules use
    // the same physical module instance as the host app. Without this, Node
    // resolves bare "react" from the workspace root which may be a different
    // version than the one bundled into the host's server.
    const resolvedShared = sharedPkgMap?.get(value);
    const relativeUrl = isRelativeSpecifier(value) ? new URL(value, base).href : undefined;
    // Apply the temp-file map to both normalized relative imports and absolute
    // HTTP imports, while keeping the rewrite scoped to actual specifiers.
    const absoluteHttpUrl =
      value.startsWith('http://') || value.startsWith('https://') ? value : undefined;
    const httpUrl = relativeUrl ?? absoluteHttpUrl;
    const tempFileUrl = httpUrl ? tempFileUrlMap?.get(httpUrl) : undefined;
    const replacement =
      tempFileUrl ?? relativeUrl ?? (resolvedShared && `file://${resolvedShared}`);
    if (replacement) rewriter.overwrite(start, end, `"${replacement}"`);
  }
  return neutralizeBrowserPreloadHelpers(rewriter.toString());
}

function isVitePreloadHelperSpecifier(specifier: string): boolean {
  return specifier.includes('preload-helper');
}

function getTempFileImportUrl(filePath: string, versionKey: string): string {
  return `file://${filePath}?v=${encodeURIComponent(versionKey)}`;
}

/**
 * Fetch an HTTP ESM module, transform it, write it to a temp file and
 * return the file path. Recursively does the same for HTTP transitive imports
 * so that `import('file:///...temp.mjs')` can resolve them.
 *
 * `versionKey` participates in both the cache key and the temp file name, so
 * a remote redeploy (new manifest → new key) produces new files and bypasses
 * Node's ESM module cache instead of serving the stale build.
 */
async function fetchEsmToTempFile(
  url: string,
  tmpDir: string,
  visited: Map<string, string>,
  pending: Set<Promise<string>>,
  sharedPkgMap?: Map<string, string>,
  versionKey: string = UNVERSIONED,
  fetchTimeoutMs: number = DEFAULT_SSR_FETCH_TIMEOUT_MS,
  contextKey = 'default',
  fetchMaxBytes: number = DEFAULT_SSR_FETCH_MAX_BYTES,
  extension = '.mjs',
  owner?: string
): Promise<string> {
  const cacheKey = JSON.stringify([
    fetchTimeoutMs,
    fetchMaxBytes,
    versionKey,
    url,
    contextKey,
    extension,
  ]);
  if (visited.has(url)) return visited.get(url)!;
  const cached = tempFileCache.get(cacheKey);
  if (cached) {
    if (owner) tempFileRecords.get(cacheKey)?.owners.add(owner);
    pending.add(cached);
    // Prefer the reserved destination so cyclic/concurrent walkers can continue
    // without awaiting the writer. If the reservation is missing, fall back to
    // the writer promise itself instead of recording an undefined path.
    const reserved = tempFilePathCache.get(cacheKey);
    const tmpFile = reserved ? await reserved : await cached;
    visited.set(url, tmpFile);
    return tmpFile;
  }

  const tmpFilePromise = (async () => {
    const { createHash } = await _crypto();
    const { join } = await _path();
    const hash = createHash('sha1').update(cacheKey).digest('hex').slice(0, 12);
    return join(tmpDir, `${hash}${extension}`);
  })();
  tempFilePathCache.set(cacheKey, tmpFilePromise);

  const promise = (async () => {
    // Reserve the destination before descending into imports. A circular edge
    // can then reference the ancestor's future file instead of awaiting the
    // ancestor's still-pending fetch promise.
    const tmpFile = await tmpFilePromise;
    visited.set(url, tmpFile);

    const res = await fetchWithTimeout(url, {}, fetchTimeoutMs);
    let code = await readResponseTextBounded(res, fetchMaxBytes, url);
    if (!res.ok) {
      throw new SsrEntryHttpError(url, res.status, res.statusText, getBodyPreview(code));
    }

    const base = url.replace(/\/[^/]*$/, '/');

    // Collect relative HTTP imports before transforming, from the same
    // specifier list the rewrite uses, so every rewritten relative import is
    // also fetched (including nested import() call-sites and the
    // zero-whitespace `import"./x.js"` form of minified Vite/Rolldown output).
    const specifiers = findSsrModuleSpecifiers(code);
    const relImports = specifiers
      .map(({ value }) => value)
      .filter((value) => isRelativeSpecifier(value) && !isVitePreloadHelperSpecifier(value))
      .map((value) => new URL(value, base).href);

    // Recursively fetch transitive HTTP imports and collect their temp paths.
    const subMap = new Map<string, string>();
    await Promise.all(
      [...new Set(relImports)]
        .filter((u) => u.startsWith('http://') || u.startsWith('https://'))
        .map(async (u) => {
          const tmpPath = await fetchEsmToTempFile(
            u,
            tmpDir,
            visited,
            pending,
            sharedPkgMap,
            versionKey,
            fetchTimeoutMs,
            contextKey,
            fetchMaxBytes,
            extension,
            owner
          );
          // Keep every generated edge on the same versioned ESM URL as the
          // root import. Without this query, a cycle back to the root resolves
          // `file:///.../root.js` separately from `file:///.../root.js?v=...`.
          subMap.set(u, getTempFileImportUrl(tmpPath, versionKey));
        })
    );

    // Transform code: absolute HTTP URLs → file:// paths for temp files,
    // and bare shared package specifiers → absolute file:// paths.
    const requireShimUrl =
      sharedPkgMap?.size && specifiers.some(({ value }) => isNodeModuleSpecifier(value))
        ? await getRequireShimUrl(tmpDir, sharedPkgMap, contextKey)
        : undefined;
    code = transformSsrCode(code, base, specifiers, sharedPkgMap, requireShimUrl, subMap);

    const { writeFileSync } = await _fs();
    writeFileSync(tmpFile, code, 'utf8');
    return tmpFile;
  })();

  const record: TempFileRecord = {
    cacheKey,
    filePathPromise: tmpFilePromise,
    promise,
    owners: owner ? new Set([owner]) : new Set(),
  };
  tempFileRecords.set(cacheKey, record);
  tempFileCache.set(cacheKey, promise);
  pending.add(promise);
  void promise.catch(() => {
    if (tempFileCache.get(cacheKey) === promise) tempFileCache.delete(cacheKey);
    if (tempFilePathCache.get(cacheKey) === tmpFilePromise) tempFilePathCache.delete(cacheKey);
    if (tempFileRecords.get(cacheKey) === record && !scheduledTempFileCleanup.has(cacheKey)) {
      tempFileRecords.delete(cacheKey);
    }
  });
  return promise;
}

async function fetchEsmGraphToTempFile(
  url: string,
  tmpDir: string,
  sharedPkgMap?: Map<string, string>,
  versionKey: string = UNVERSIONED,
  fetchTimeoutMs: number = DEFAULT_SSR_FETCH_TIMEOUT_MS,
  contextKey = 'default',
  fetchMaxBytes: number = DEFAULT_SSR_FETCH_MAX_BYTES,
  extension = '.mjs',
  owner?: string
): Promise<string> {
  const pending = new Set<Promise<string>>();
  const rootFile = await fetchEsmToTempFile(
    url,
    tmpDir,
    new Map(),
    pending,
    sharedPkgMap,
    versionKey,
    fetchTimeoutMs,
    contextKey,
    fetchMaxBytes,
    extension,
    owner
  );
  // Circular edges return their reserved path immediately. Wait for every
  // discovered writer before importing the root so all referenced files exist.
  await Promise.all(pending);
  return rootFile;
}

async function importTempModule(
  filePath: string,
  versionKey: string
): Promise<{ init: unknown; get: unknown }> {
  // The version query busts Node's ESM module cache (and any stale resolution
  // state) when a remote redeploys: same temp path + new version → fresh module.
  return (await import(/* @vite-ignore */ `${filePath}?v=${encodeURIComponent(versionKey)}`)) as {
    init: unknown;
    get: unknown;
  };
}

let warnedVmUnavailable = false;
let vmStrategyModulePromise: Promise<typeof import('./ssrVmStrategy')> | undefined;

function getVmStrategyModule(): Promise<typeof import('./ssrVmStrategy')> {
  if (!vmStrategyModulePromise) {
    vmStrategyModulePromise = import('./ssrVmStrategy');
  }
  return vmStrategyModulePromise;
}

/**
 * Non-HTTP failures keep falling back (to temp-file after vm, to the federation
 * runtime's own Node loader after temp-file), but whatever the fallback throws
 * then hides the real cause, so report it first.
 */
function warnStrategyFallback(
  strategy: 'vm' | 'temp-file',
  url: string,
  fallback: string,
  error: unknown
): void {
  mfWarn(
    `SSR entry loader: strategy "${strategy}" failed to load ${url}; falling back to ${fallback}.`,
    error
  );
}

async function tryVmStrategy(
  ssrEntry: SsrEntryCandidate,
  options: ResolvedLoaderOptions,
  rootEntryUrl: string
): Promise<{ init: unknown; get: unknown } | null> {
  const { loadViaVmStrategy, isVmStrategyAvailable } = await getVmStrategyModule();

  if (!(await isVmStrategyAvailable())) {
    if (!warnedVmUnavailable) {
      warnedVmUnavailable = true;
      mfWarn(
        'SSR entry loader: strategy "vm" requires vm.SourceTextModule ' +
          '(run Node with --experimental-vm-modules); falling back to the temp-file strategy.'
      );
    }
    return null;
  }

  return (await loadViaVmStrategy(ssrEntry.url, {
    resolvedShared: options.resolvedShared,
    shareScopeName: options.shareScopeName,
    versionKey: ssrEntry.versionKey,
    fetchTimeoutMs: options.fetchTimeoutMs,
    fetchMaxBytes: options.fetchMaxBytes,
    cacheContext: options.cacheContext,
    federationInstance: options.federationInstance,
    rootEntryUrl,
  })) as { init: unknown; get: unknown } | null;
}

async function loadSSRRemoteEntry(
  ssrEntry: SsrEntryCandidate,
  options: ResolvedLoaderOptions,
  rootEntryUrl: string
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
      const runner = await getOrCreateRunner(
        remoteOrigin,
        resolvedShared,
        options.fetchTimeoutMs,
        options.fetchMaxBytes
      );
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
        } catch (error) {
          if (isSsrFetchBodyTooLargeError(error)) throw error;
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
        const fromVm = await tryVmStrategy(ssrEntry, options, rootEntryUrl);
        if (fromVm) return fromVm;
      } catch (error) {
        if (isSsrEntryHttpError(error) || isSsrFetchBodyTooLargeError(error)) throw error;
        warnStrategyFallback('vm', url, 'the temp-file strategy', error);
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

    // `.mjs`/`.cjs` tell Node the module format up front. CommonJS entries
    // reach this path only when createRequire cannot load their http URL.
    const isCommonJs = type === 'commonjs-module' || type === 'commonjs';
    const extension = isCommonJs ? '.cjs' : '.mjs';

    try {
      const tmpFile = await fetchEsmGraphToTempFile(
        url,
        cacheDir,
        sharedPkgMap,
        versionKey,
        options.fetchTimeoutMs,
        getSsrTransformContextKey(resolvedShared, options.shareScopeName),
        options.fetchMaxBytes,
        extension,
        rootEntryUrl
      );
      // Node's require returns the container (`module.exports`), not an ES
      // namespace, and bypasses Vite's dev module runner, which evaluates
      // every file as an ES module.
      if (isCommonJs) {
        return (await _module()).createRequire(import.meta.url)(tmpFile) as {
          init: unknown;
          get: unknown;
        };
      }
      return await importTempModule(tmpFile, versionKey);
    } catch (error) {
      if (isSsrEntryHttpError(error) || isSsrFetchBodyTooLargeError(error)) throw error;
      warnStrategyFallback('temp-file', url, "the federation runtime's loader", error);
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
interface SsrEntryLoaderOptions extends SsrEntryLoaderConfig {
  /**
   * Pre-resolved absolute file paths for common shared packages, keyed by
   * bare specifier. Populated at build time by the Vite plugin from the MF
   * plugin's own installed location so the resolution is package-manager-
   * agnostic. ssrEntryLoader uses these directly when rewriting bare specifiers
   * in remote SSR entry temp files — no runtime createRequire walk-up needed.
   */
  resolvedShared?: Record<string, string>;
  /**
   * Share scope consulted by the `'vm'` strategy when linking bare imports.
   * Defaults to `'default'`.
   */
  shareScopeName?: string;
}

interface ResolvedLoaderOptions {
  resolvedShared: Record<string, string>;
  strategy: 'temp-file' | 'vm';
  shareScopeName: string;
  maxAgeMs?: number;
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  cacheContext: object;
  federationInstance?: object;
}

// Default export so the module can be referenced as a runtimePlugin path string.
export default function ssrEntryLoaderPlugin(options: SsrEntryLoaderOptions = {}) {
  const resolved: ResolvedLoaderOptions = {
    resolvedShared: options.resolvedShared ?? {},
    strategy: options.strategy ?? 'temp-file',
    shareScopeName: options.shareScopeName ?? 'default',
    maxAgeMs: options.maxAgeMs,
    fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_SSR_FETCH_TIMEOUT_MS,
    fetchMaxBytes: options.fetchMaxBytes ?? DEFAULT_SSR_FETCH_MAX_BYTES,
    cacheContext: {},
  };
  return {
    name: 'mf-vite:ssr-entry-loader',
    async loadEntry({ remoteInfo, origin }: { remoteInfo: RemoteInfo; origin?: object }) {
      // Only intercept on the server — browser should use the normal path.
      if (!isNodeServer()) return;

      // The runtime supplies the owning ModuleFederation instance as `origin`.
      // Its identity is the VM graph's true share-resolution boundary. Keep a
      // stable factory-local fallback for direct or older-runtime invocations.
      const loadOptions = origin
        ? { ...resolved, cacheContext: origin, federationInstance: origin }
        : resolved;

      const ssrEntry = await getSSREntry(
        remoteInfo.entry,
        loadOptions.maxAgeMs,
        loadOptions.fetchTimeoutMs,
        loadOptions.fetchMaxBytes
      );
      if (!ssrEntry) return;

      // A direct `.ssr.js` entry (e.g. a manifest's `ssrRemoteEntry`) carries
      // its module format on remoteInfo, such as Rspack's `commonjs-module`.
      const mod = await loadSSRRemoteEntry(
        ssrEntry.url === remoteInfo.entry && remoteInfo.type
          ? { ...ssrEntry, type: remoteInfo.type }
          : ssrEntry,
        loadOptions,
        remoteInfo.entry
      );
      if (!mod) return;

      return mod;
    },
  };
}
