import {
  getInstance,
  init as initRuntime,
  loadRemote,
  registerRemotes,
} from '@module-federation/runtime';
import type { ModuleFederation } from '@module-federation/runtime';
import ssrEntryLoaderPlugin from './utils/ssrEntryLoader';

export * from '@module-federation/runtime';

type FederationUserOptions = Parameters<typeof initRuntime>[0];
type RuntimeRemote = Parameters<ModuleFederation['registerRemotes']>[0][number];
type LoadRemoteOptions = NonNullable<Parameters<ModuleFederation['loadRemote']>[1]>;

export type FederationRuntimeTarget = 'web' | 'node';

export interface ManifestFetchOptions {
  cache?: boolean;
  cacheTtl?: number;
  fetch?: typeof fetch;
  fetchInit?: RequestInit;
  force?: boolean;
  runtimeKey?: string;
}

export interface RegisterManifestRemoteOptions extends ManifestFetchOptions {
  remoteName?: string;
  shareScope?: string;
  target?: FederationRuntimeTarget;
}

interface ManifestRemoteEntry {
  name: string;
  path?: string;
  type?: string;
}

interface FederationManifest {
  name?: string;
  metaData: {
    globalName?: string;
    publicPath?: string;
    remoteEntry: ManifestRemoteEntry;
    ssrRemoteEntry?: ManifestRemoteEntry;
  };
}

interface ManifestCacheEntry {
  expiresAt: number;
  manifest: FederationManifest;
}

const manifestCache = new Map<string, ManifestCacheEntry>();

function getRuntimeKey(runtimeKey?: string): string {
  return runtimeKey || 'default';
}

function getManifestCacheKey(manifestUrl: string, runtimeKey?: string): string {
  return `${getRuntimeKey(runtimeKey)}:${manifestUrl}`;
}

function isCacheEnabled(options: ManifestFetchOptions): boolean {
  return options.cache !== false;
}

function getCacheTtl(options: ManifestFetchOptions): number {
  return options.cacheTtl ?? 30_000;
}

function getDefaultTarget(target?: FederationRuntimeTarget): FederationRuntimeTarget {
  if (target) return target;
  return typeof (globalThis as { window?: unknown }).window === 'undefined' ? 'node' : 'web';
}

function assertManifest(manifestUrl: string, value: unknown): asserts value is FederationManifest {
  const manifest = value as Partial<FederationManifest>;
  if (!manifest || typeof manifest !== 'object' || !manifest.metaData?.remoteEntry?.name) {
    throw new Error(`Invalid module federation manifest: ${manifestUrl}`);
  }
}

function joinEntryPath(entry: ManifestRemoteEntry): string {
  return `${entry.path || ''}${entry.name}`;
}

function resolveManifestAssetUrl(
  manifestUrl: string,
  entry: ManifestRemoteEntry,
  publicPath?: string
): string {
  const entryPath = joinEntryPath(entry);
  if (/^(https?:)?\/\//.test(entryPath)) return entryPath;
  if (publicPath && publicPath !== 'auto' && /^(https?:)?\/\//.test(publicPath)) {
    return new URL(entryPath, publicPath.endsWith('/') ? publicPath : `${publicPath}/`).href;
  }
  return new URL(entryPath, manifestUrl.replace(/[^/]*$/, '')).href;
}

function getManifestEntryForTarget(
  manifest: FederationManifest,
  target: FederationRuntimeTarget
): ManifestRemoteEntry {
  if (target === 'node' && manifest.metaData.ssrRemoteEntry?.name) {
    return manifest.metaData.ssrRemoteEntry;
  }
  return manifest.metaData.remoteEntry;
}

function resolveFromHost(specifier: string): string | undefined {
  try {
    const getBuiltinModule = (globalThis.process as { getBuiltinModule?: unknown } | undefined)
      ?.getBuiltinModule;
    if (typeof getBuiltinModule === 'function') {
      const mod = getBuiltinModule('module') as { createRequire?: unknown };
      if (typeof mod.createRequire === 'function' && process.cwd) {
        return (mod.createRequire(`${process.cwd()}/package.json`) as NodeRequire).resolve(
          specifier
        );
      }
    }
  } catch {
    // fall through
  }

  return undefined;
}

function getDefaultResolvedShared(options: FederationUserOptions): Record<string, string> {
  const specifiers = new Set([
    '@module-federation/runtime',
    '@module-federation/runtime-core',
    '@module-federation/sdk',
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'vue',
  ]);

  for (const shared of Object.keys(options.shared ?? {})) specifiers.add(shared);

  const resolvedShared: Record<string, string> = {};
  for (const specifier of specifiers) {
    const resolved = resolveFromHost(specifier);
    if (resolved) resolvedShared[specifier] = resolved;
  }
  return resolvedShared;
}

export function createFederationInstance(options: FederationUserOptions): ModuleFederation {
  // Use init(), not createInstance(): @module-federation/runtime's top-level
  // loadRemote/registerRemotes/loadShare helpers are wired to init's singleton.
  return initRuntime(options);
}

export function createServerFederationInstance(options: FederationUserOptions): ModuleFederation {
  const plugins = [
    ssrEntryLoaderPlugin({ resolvedShared: getDefaultResolvedShared(options) }),
    ...(options.plugins || []),
  ];
  return initRuntime({
    ...options,
    plugins,
    inBrowser: false,
  } as FederationUserOptions & { inBrowser: false });
}

export async function fetchFederationManifest(
  manifestUrl: string,
  options: ManifestFetchOptions = {}
): Promise<FederationManifest> {
  const cacheKey = getManifestCacheKey(manifestUrl, options.runtimeKey);
  if (options.force) manifestCache.delete(cacheKey);

  const cached = manifestCache.get(cacheKey);
  if (cached && isCacheEnabled(options) && cached.expiresAt > Date.now()) {
    return cached.manifest;
  }

  const fetchFn = options.fetch || fetch;
  const response = await fetchFn(manifestUrl, options.fetchInit);
  if (!response.ok) {
    throw new Error(`Failed to fetch module federation manifest: ${manifestUrl}`);
  }

  const manifest = await response.json();
  assertManifest(manifestUrl, manifest);

  if (isCacheEnabled(options)) {
    manifestCache.set(cacheKey, {
      expiresAt: Date.now() + getCacheTtl(options),
      manifest,
    });
  }

  return manifest;
}

export async function registerManifestRemote(
  remoteAlias: string,
  manifestUrl: string,
  options: RegisterManifestRemoteOptions = {}
): Promise<RuntimeRemote> {
  const target = getDefaultTarget(options.target);
  const manifest = await fetchFederationManifest(manifestUrl, options);
  const selectedEntry = getManifestEntryForTarget(manifest, target);
  const remoteName = options.remoteName || manifest.name || remoteAlias;
  const registration = {
    alias: remoteAlias === remoteName ? undefined : remoteAlias,
    entry: resolveManifestAssetUrl(manifestUrl, selectedEntry, manifest.metaData.publicPath),
    entryGlobalName: manifest.metaData.globalName || remoteName,
    name: remoteName,
    shareScope: options.shareScope || 'default',
    type: selectedEntry.type || 'module',
  } as RuntimeRemote;

  registerRemotes([registration], { force: options.force });
  return registration;
}

export async function loadRemoteFromManifest<T>(
  remoteId: string,
  manifestUrl: string,
  options: RegisterManifestRemoteOptions & Partial<LoadRemoteOptions> = {}
): Promise<T | null> {
  const remoteAlias = remoteId.split('/')[0];
  if (!remoteAlias) throw new Error(`Invalid remote id "${remoteId}".`);

  const {
    cache,
    cacheTtl,
    fetch,
    fetchInit,
    force,
    remoteName,
    runtimeKey,
    shareScope,
    target,
    ...loadOptions
  } = options;

  await registerManifestRemote(remoteAlias, manifestUrl, {
    cache,
    cacheTtl,
    fetch,
    fetchInit,
    force,
    remoteName,
    runtimeKey,
    shareScope,
    target,
  });

  return loadRemote<T>(remoteId, {
    from: 'runtime',
    ...loadOptions,
  } as LoadRemoteOptions);
}

export function createFederationRuntimeScope(runtimeKey: string) {
  return {
    createFederationInstance,
    createServerFederationInstance,
    fetchFederationManifest: (manifestUrl: string, options?: ManifestFetchOptions) =>
      fetchFederationManifest(manifestUrl, { ...options, runtimeKey }),
    getInstance,
    loadRemoteFromManifest: <T>(
      remoteId: string,
      manifestUrl: string,
      options?: RegisterManifestRemoteOptions & Partial<LoadRemoteOptions>
    ) => loadRemoteFromManifest<T>(remoteId, manifestUrl, { ...options, runtimeKey }),
    registerManifestRemote: (
      remoteAlias: string,
      manifestUrl: string,
      options?: RegisterManifestRemoteOptions
    ) => registerManifestRemote(remoteAlias, manifestUrl, { ...options, runtimeKey }),
    runtimeKey,
  };
}
