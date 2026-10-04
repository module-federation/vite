import {
  type BasicStatsMetaData,
  inferAutoPublicPath,
  type Manifest,
} from '@module-federation/sdk';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isAbsoluteUrl } from './buildPaths';
import type {
  ModuleFederationOptions,
  RemoteObjectConfig,
} from './normalizeModuleFederationOptions';
import { ensureTrailingSlash } from './pathNormalization';

/** Virtual-module prefix of the host's per-share re-export entries. */
export const SHARE_MODULE_PREFIX = '\0mf-host-provided-share:';

/**
 * A remote built with `experiments.hostProvidesAllShared` emits a standard `mf-manifest.json`
 * whose `metaData` has no `remoteEntry`: there is no runtime container, each expose is loaded
 * straight from its `assets.js.sync` entry. A manifest with a `remoteEntry` belongs to a
 * Module Federation runtime remote, whose chunks need that runtime, so the host rejects it.
 */
export interface HostProvidesAllSharedManifest extends Omit<Manifest, 'metaData'> {
  metaData: Omit<BasicStatsMetaData, 'remoteEntry' | 'types'> & {
    remoteEntry?: never;
    /** `zip` / `api` are absent when type generation is off, as in `pluginMFManifest`. */
    types?: Partial<BasicStatsMetaData['types'] & object> & { path: string; name: string };
    publicPath?: string;
    getPublicPath?: string;
  };
}

/** `./a/b` → `a/b`, `.` → `index`: the fixed entry name of an expose, without `.js`. */
export function exposeEntryName(exposeKey: string): string {
  return exposeKey === '.' ? 'index' : exposeKey.replace(/^\.\//, '');
}

/** Bare specifier a host uses for an expose: `remote` for `.`, `remote/a/b` otherwise. */
export function remoteSpecifier(remoteName: string, exposeKey: string): string {
  const entry = exposeEntryName(exposeKey);
  return entry === 'index' ? remoteName : `${remoteName}/${entry}`;
}

/** `id` is a remote alias or a subpath of one. */
export function isRemoteSpecifier(id: string, remoteKeys: readonly string[]): boolean {
  return remoteKeys.some((key) => id === key || id.startsWith(`${key}/`));
}

/**
 * The shared key that owns `id`: an exact match, else the longest key `id` is a subpath
 * of (`lodash-es/debounce` → `lodash-es`). Used to spot an unshared subpath of a shared
 * package, which would bundle a private copy of that package into a remote.
 */
export function sharedKeyOwning(id: string, sharedKeys: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const key of sharedKeys) {
    if (id !== key && !id.startsWith(`${key}/`)) continue;
    if (!owner || key.length > owner.length) owner = key;
  }
  return owner;
}

/** Chunk name of the host's re-export entry for a shared key. */
export function shareChunkName(key: string): string {
  return `shared/${key.replace(/^@/, '').replace(/[^\w-]+/g, '-')}`;
}

/** Reads a remote's `mf-manifest.json` from a URL or a path relative to `root`. */
export async function readHostProvidesAllSharedManifest(
  location: string,
  root: string
): Promise<HostProvidesAllSharedManifest> {
  let source: string;
  if (isAbsoluteUrl(location)) {
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${location}: ${response.status} ${response.statusText}`);
    }
    source = await response.text();
  } else {
    source = await readFile(path.resolve(root, location), 'utf8');
  }
  const manifest = JSON.parse(source) as Partial<HostProvidesAllSharedManifest>;
  if (!manifest.metaData || !Array.isArray(manifest.exposes)) {
    throw new Error(`${location} is not a Module Federation manifest.`);
  }
  if (manifest.metaData.remoteEntry) {
    throw new Error(
      `${location} describes a Module Federation runtime remote (it has a remoteEntry). ` +
        'Build the remote with `experiments: { hostProvidesAllShared: true }`.'
    );
  }
  return manifest as HostProvidesAllSharedManifest;
}

/** URL prefix of a remote's files: `metaData.publicPath`, `auto` inferred from the manifest URL. */
export function remotePublicPath(
  manifest: HostProvidesAllSharedManifest,
  location: string
): string {
  // A `getPublicPath` function body cannot be evaluated at build time: treat it as `auto`.
  const publicPath = manifest.metaData.publicPath ?? 'auto';
  if (publicPath !== 'auto') return ensureTrailingSlash(publicPath);
  if (!isAbsoluteUrl(location)) {
    throw new Error(
      `${location}: publicPath is "auto", which can only be inferred from a manifest URL. ` +
        'Reference the manifest by URL or set `base` / `publicPath` in the remote build.'
    );
  }
  return ensureTrailingSlash(inferAutoPublicPath(location));
}

/** Import-map entries (`remote/Expose` → URL) for every expose of every remote. */
export async function collectRemoteImports(
  remotes: Record<string, RemoteObjectConfig>,
  root: string
): Promise<Record<string, string>> {
  const imports: Record<string, string> = {};
  for (const [alias, remote] of Object.entries(remotes)) {
    const manifest = await readHostProvidesAllSharedManifest(remote.entry, root);
    const publicPath = remotePublicPath(manifest, remote.entry);
    for (const expose of manifest.exposes) {
      const file = expose.assets.js.sync[0];
      if (!expose.path || !file) continue;
      imports[remoteSpecifier(alias, expose.path)] = isAbsoluteUrl(remote.entry)
        ? new URL(file, new URL(publicPath, remote.entry)).href
        : publicPath + file;
    }
  }
  return imports;
}

/** Top-level options that only the Module Federation runtime or `remoteEntry.js` pipeline reads. */
const IGNORED_OPTIONS = [
  'filename',
  'ssrFilename',
  'varFilename',
  'library',
  'runtime',
  'shareScope',
  'shareStrategy',
  'runtimePlugins',
  'implementation',
  'getPublicPath',
  'ignoreOrigin',
  'virtualModuleDir',
  'hostInitInjectLocation',
  'bundleAllCSS',
  'treeShakingDir',
  'injectTreeShakingUsedExports',
  'treeShakingSharedPlugins',
  'treeShakingSharedExcludePlugins',
  'moduleParseTimeout',
  'moduleParseIdleTimeout',
  'target',
  'ssrExternals',
  'ssrEntryLoader',
  'disableRemote',
  'disableShared',
  'disableSnapshot',
] as const;
const IGNORED_EXPERIMENTS = ['externalRuntime', 'provideExternalRuntime', 'ssrMode'] as const;
/** Per-share options: version negotiation, aliasing and fallbacks do not exist in this mode. */
const IGNORED_SHARE_OPTIONS = [
  'eager',
  'requiredVersion',
  'strictVersion',
  'import',
  'request',
  'shareKey',
  'name',
  'version',
  'shareScope',
  'treeShaking',
  'allowNodeModulesSuffixMatch',
  'suppressMissingImportWarning',
] as const;

const isSet = (value: unknown) =>
  value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);

/** A single warning naming every option the user set that import-map mode ignores. */
export function getIgnoredOptionWarning(options: ModuleFederationOptions): string | undefined {
  const shared = options.shared;
  const ignored = [
    ...IGNORED_OPTIONS.filter((key) => isSet(options[key])).map((key) => `\`${key}\``),
    ...IGNORED_EXPERIMENTS.filter((key) => isSet(options.experiments?.[key])).map(
      (key) => `\`experiments.${key}\``
    ),
    ...(shared && !Array.isArray(shared)
      ? Object.entries(shared).flatMap(([key, config]) =>
          typeof config === 'object' && config !== null
            ? IGNORED_SHARE_OPTIONS.filter((option) =>
                // `import: false` is the one `false` worth naming: it contradicts this mode.
                option === 'import' ? config.import !== undefined : isSet(config[option])
              ).map((option) => `\`shared.${key}.${option}\``)
            : []
        )
      : []),
  ];
  if (ignored.length === 0) return undefined;
  return (
    `experiments.hostProvidesAllShared: ${ignored.join(', ')} ignored. The Module Federation ` +
    'runtime is not used and the host provides the only copy of every shared key.'
  );
}
