import { SharedConfig, ShareStrategy } from '@module-federation/runtime/types';
import type { moduleFederationPlugin } from '@module-federation/sdk';

export type RemoteEntryType =
  | 'var'
  | 'module'
  | 'assign'
  | 'assign-properties'
  | 'this'
  | 'window'
  | 'self'
  | 'global'
  | 'commonjs'
  | 'commonjs2'
  | 'commonjs-module'
  | 'commonjs-static'
  | 'amd'
  | 'amd-require'
  | 'umd'
  | 'umd2'
  | 'jsonp'
  | 'system'
  | string;

import * as fs from 'fs';
import * as path from 'node:path';
import { createModuleFederationError, mfWarn } from './logger';
import {
  getInstalledPackageJson,
  getPackageDetectionCwd,
  getPackageName,
  resolveImportPath,
} from './packageUtils';
import { getCommonSharedSubpaths } from './pathNormalization';
import { findSharedKey } from './sharedKeyMatcher';
import { normalizePathForImport } from './buildPaths';

interface ExposesItem {
  import: string;
}
export interface NormalizedShared {
  [key: string]: ShareItem;
}
export interface RemoteObjectConfig {
  type?: string;
  name: string;
  internalName?: string;
  entry: string;
  entryGlobalName?: string;
  shareScope?: string | string[];
}

const INTERNAL_NAME_PREFIX = '__mfe_internal__';

export function toInternalModuleFederationName(name: string) {
  return name.startsWith(INTERNAL_NAME_PREFIX) ? name : `${INTERNAL_NAME_PREFIX}${name}`;
}

function warnOnReservedInternalNamePrefix(name: string, kind: 'containerName' | 'remoteAlias') {
  if (!name.startsWith(INTERNAL_NAME_PREFIX)) return;
  mfWarn(
    `Reserved internal ${kind} prefix "${INTERNAL_NAME_PREFIX}" detected in public ${kind} "${name}". ` +
      'This prefix is reserved for internal module federation names and may cause conflicts.'
  );
}

function normalizeExposesItem(item: string | { import: string }): ExposesItem {
  let importPath: string = '';
  if (typeof item === 'string') {
    importPath = item;
  }
  if (typeof item === 'object') {
    importPath = item.import;
  }
  return {
    import: importPath,
  };
}

function normalizeExposes(
  exposes: Record<string, string | { import: string }> | undefined
): Record<string, ExposesItem> {
  if (!exposes) return {};
  const res: Record<string, ExposesItem> = {};
  Object.keys(exposes).forEach((key) => {
    res[key] = normalizeExposesItem(exposes[key]);
  });
  return res;
}

export function normalizeRemotes(
  remotes: Record<string, string | RemoteObjectConfig> | undefined
): Record<string, RemoteObjectConfig> {
  if (!remotes) return {};
  const result: Record<string, RemoteObjectConfig> = {};
  if (typeof remotes === 'object') {
    Object.keys(remotes).forEach((key) => {
      result[key] = normalizeRemoteItem(key, remotes[key]);
    });
  }
  return result;
}

function warnOmittedObjectRemoteType(remoteKey: string): void {
  mfWarn(
    `Remote "${remoteKey}" omits type and defaults to 'var'. ` +
      `Set type: 'module' for Vite ESM remotes, or type: 'var' explicitly to silence this warning.`
  );
}

function normalizeRemoteItem(key: string, remote: string | RemoteObjectConfig): RemoteObjectConfig {
  warnOnReservedInternalNamePrefix(key, 'remoteAlias');
  if (typeof remote === 'string') {
    // Scoped packages start with '@', so the name/entry separator is the
    // first '@' after the optional scope prefix, not the last '@' overall.
    const separatorIndex = remote.startsWith('@') ? remote.indexOf('@', 1) : remote.indexOf('@');
    let entryGlobalName: string;
    let entry: string;
    if (separatorIndex > 0) {
      entryGlobalName = remote.slice(0, separatorIndex);
      entry = remote.slice(separatorIndex + 1);
    } else {
      entryGlobalName = remote;
      entry = remote;
    }
    return {
      type: 'var',
      name: key,
      internalName: toInternalModuleFederationName(key),
      entry,
      entryGlobalName,
      shareScope: 'default',
    };
  }

  const typeOmitted = remote.type === undefined || remote.type === null || remote.type === '';
  if (typeOmitted) {
    warnOmittedObjectRemoteType(key);
  }

  return Object.assign(
    {
      type: 'var',
      name: key,
      internalName: toInternalModuleFederationName(key),
      shareScope: 'default',
      entryGlobalName: key,
    },
    {
      ...remote,
      type: typeOmitted ? 'var' : remote.type,
      internalName: toInternalModuleFederationName(remote.name || key),
    }
  );
}

export interface ShareItem {
  name: string;
  version: string | undefined;
  scope: string;
  from: string;
  shareConfig: SharedConfig &
    moduleFederationPlugin.SharedConfig & {
      allowNodeModulesSuffixMatch?: boolean;
      treeShaking?: TreeShakingConfig;
      suppressMissingImportWarning?: boolean;
    };
}

export interface TreeShakingConfig {
  mode: 'server-calc' | 'runtime-infer';
  usedExports?: string[];
}

/**
 * Tries to find the package.json's version of a shared package
 * if `package.json` is not declared in `exports`
 * @param {string} sharedName
 * @returns {string | undefined}
 */
function searchPackageVersion(sharedName: string, cwd: string): string | undefined {
  // Let getInstalledPackageJson derive the bare package name from the shared
  // key via its default `getPackageName(pkg)` behavior. Forcing
  // `packageName: sharedName` here broke version resolution for any shared
  // subpath like "@scope/foo/bar": the pnpm-store walk looks up a
  // package.json whose `name` field equals `packageName`, but no real
  // package is named "@scope/foo/bar", so the walk always misses and
  // `version` stays undefined. The bare package name "@scope/foo" matches.
  const installed = getInstalledPackageJson(sharedName, { cwd });
  const version = installed?.packageJson.version;
  return typeof version === 'string' ? version : undefined;
}

function inferVersionFromRequiredVersion(
  requiredVersion?: moduleFederationPlugin.SharedConfig['requiredVersion']
): string | undefined {
  if (typeof requiredVersion !== 'string') return undefined;

  const isDigit = (char: string | undefined): boolean =>
    char !== undefined && char >= '0' && char <= '9';
  const isSuffixChar = (char: string | undefined): boolean =>
    char !== undefined &&
    ((char >= '0' && char <= '9') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      char === '.' ||
      char === '-');

  let index = 0;
  while (index < requiredVersion.length) {
    if (!isDigit(requiredVersion[index])) {
      index += 1;
      continue;
    }

    const start = index;
    while (isDigit(requiredVersion[index])) index += 1;
    if (requiredVersion[index] !== '.') continue;

    index += 1;
    if (!isDigit(requiredVersion[index])) continue;
    while (isDigit(requiredVersion[index])) index += 1;
    if (requiredVersion[index] !== '.') continue;

    index += 1;
    if (!isDigit(requiredVersion[index])) continue;
    while (isDigit(requiredVersion[index])) index += 1;

    if (
      (requiredVersion[index] === '-' || requiredVersion[index] === '+') &&
      isSuffixChar(requiredVersion[index + 1])
    ) {
      index += 1;
      while (isSuffixChar(requiredVersion[index])) index += 1;
    }
    return requiredVersion.slice(start, index);
  }

  return undefined;
}

/** URI-style package specifiers are not semver ranges for runtime satisfy(). */
const PACKAGE_SPECIFIER_PROTOCOL_RE = /^[a-z][a-z\d+.-]*:/i;

function isProtocolRequiredVersion(requiredVersion: string): boolean {
  return PACKAGE_SPECIFIER_PROTOCOL_RE.test(requiredVersion.trim());
}

// One comparator of a semver range: "^1.2.3", ">=", "1.x", "*", or the "-" of
// a hyphen range. Dist-tags ("latest") and GitHub shorthands ("user/repo") are
// valid package.json ranges but not semver ranges for runtime satisfy().
const SEMVER_COMPARATOR_RE =
  /^(?:[<>=~^]*v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*]))*(?:[-+][\w.-]+)?|[<>=~^]+|[xX*]|-)$/;

function isSemverRange(range: string): boolean {
  return range.split('||').every((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    return comparators.length > 0 && comparators.every((c) => SEMVER_COMPARATOR_RE.test(c));
  });
}

function isUsableRequiredVersion(requiredVersion: string): boolean {
  return (
    requiredVersion.trim() !== '' &&
    !isProtocolRequiredVersion(requiredVersion) &&
    isSemverRange(requiredVersion)
  );
}

/** Bare specifiers name an installed package; relative/absolute paths do not. */
function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('\0') &&
    !path.isAbsolute(specifier) &&
    !PACKAGE_SPECIFIER_PROTOCOL_RE.test(specifier)
  );
}

type ProjectPackageJsonCache = Map<string, Record<string, any> | undefined>;

// Reads only `${cwd}/package.json`, no upward walk: a workspace-root
// declaration is not this project's requirement.
function readProjectPackageJson(
  cwd: string,
  cache: ProjectPackageJsonCache
): Record<string, any> | undefined {
  if (cache.has(cwd)) return cache.get(cwd);
  let packageJson: Record<string, any> | undefined;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    // Projects without a package.json keep the installed-version fallback.
  }
  cache.set(cwd, packageJson);
  return packageJson;
}

function getLitExportSubpathShares(sharedName: string): string[] {
  if (sharedName !== 'lit') return [];

  const installedPackageJson = getInstalledPackageJson(sharedName, {
    packageName: sharedName,
  });
  const exportsField = installedPackageJson?.packageJson.exports;
  if (!exportsField || typeof exportsField === 'string') return [];

  return Object.keys(exportsField as Record<string, unknown>)
    .filter((key) => key.startsWith('./') && key !== '.' && !key.includes('*'))
    .map((key) => `${sharedName}/${key.slice(2)}`);
}

type SharedVersionConfig = Pick<
  moduleFederationPlugin.SharedConfig,
  'import' | 'requiredVersion'
> & {
  version?: string;
};

// Keep the user's settings separate from inferred values so a later root lookup
// cannot mistake an inferred version for an explicit override.
const sharedVersionConfigs = new WeakMap<ShareItem, SharedVersionConfig>();

function resolveSharedVersion(
  key: string,
  config: SharedVersionConfig,
  cwd: string,
  packageJsonCache: ProjectPackageJsonCache = new Map(),
  fallbackVersion?: string
) {
  // A replacement package carries its own version; a local shim or path
  // import still describes the share key's package.
  const source =
    typeof config.import === 'string' && isBareSpecifier(config.import) ? config.import : key;
  // Consume-only shares also need a version for runtime validation.
  const version =
    config.version ||
    searchPackageVersion(source, cwd) ||
    inferVersionFromRequiredVersion(config.requiredVersion) ||
    fallbackVersion;
  let requiredVersion = config.requiredVersion;
  if (requiredVersion === undefined && !config.version) {
    const packageJson = readProjectPackageJson(cwd, packageJsonCache);
    const packageName = getPackageName(source);
    requiredVersion =
      packageJson?.dependencies?.[packageName] ??
      packageJson?.devDependencies?.[packageName] ??
      packageJson?.peerDependencies?.[packageName] ??
      packageJson?.optionalDependencies?.[packageName];
  }

  if (
    requiredVersion === false ||
    (typeof requiredVersion === 'string' && isUsableRequiredVersion(requiredVersion))
  ) {
    return { version, requiredVersion };
  }
  return {
    version,
    requiredVersion:
      config.import === false || config.version ? '*' : version ? `^${version}` : '*',
  };
}

export function resolveSharedVersions(shared: NormalizedShared, root: string) {
  const packageJsonCache: ProjectPackageJsonCache = new Map();
  for (const [key, item] of Object.entries(shared)) {
    const config = sharedVersionConfigs.get(item);
    if (!config) continue;
    // The eager lookup's version is the last resort when the root lookup
    // misses: an installed version beats "0" for runtime satisfy().
    const { version, requiredVersion } = resolveSharedVersion(
      key,
      config,
      root,
      packageJsonCache,
      item.version
    );
    item.version = version;
    item.shareConfig.requiredVersion = requiredVersion;
  }
}

function normalizeShareItem(
  key: string,
  shareItem:
    | string
    | {
        name: string;
        import: moduleFederationPlugin.SharedConfig['import'];
        version?: string;
        shareScope?: string;
        request?: moduleFederationPlugin.SharedConfig['request'];
        shareKey?: moduleFederationPlugin.SharedConfig['shareKey'];
        singleton?: boolean;
        eager?: boolean;
        requiredVersion?: moduleFederationPlugin.SharedConfig['requiredVersion'];
        strictVersion?: boolean;
        allowNodeModulesSuffixMatch?: boolean;
        suppressMissingImportWarning?: boolean;
        treeShaking?: TreeShakingConfig;
      }
): ShareItem {
  const treeShaking = typeof shareItem === 'object' ? shareItem.treeShaking : undefined;
  if (treeShaking && treeShaking.mode !== 'server-calc' && treeShaking.mode !== 'runtime-infer') {
    throw createModuleFederationError(
      `Invalid shared config for "${key}": treeShaking.mode must be either "server-calc" or "runtime-infer".`
    );
  }
  if (treeShaking && typeof shareItem === 'object' && shareItem.eager) {
    throw createModuleFederationError(
      `Invalid shared config for "${key}": cannot use both "eager: true" and "treeShaking.mode" simultaneously. Choose one strategy.`
    );
  }
  if (
    treeShaking?.mode === 'runtime-infer' &&
    typeof shareItem === 'object' &&
    shareItem.singleton
  ) {
    mfWarn(
      `Shared singleton "${key}" uses runtime-infer tree shaking, which may load both a tree-shaken bundle and a full bundle when consumers require different exports. ` +
        'Prefer server-calc for singleton dependencies. If runtime-infer is required, expand usedExports to reduce this risk.'
    );
  }

  const config = typeof shareItem === 'object' ? shareItem : {};
  const { version, requiredVersion } = resolveSharedVersion(key, config, getPackageDetectionCwd());
  if (typeof shareItem === 'string') {
    const result: ShareItem = {
      name: shareItem,
      version,
      scope: 'default',
      from: '',
      shareConfig: {
        import: undefined,
        singleton: false,
        eager: false,
        requiredVersion,
      },
    };
    sharedVersionConfigs.set(result, { ...config });
    return result;
  }
  const result: ShareItem = {
    name: key,
    from: '',
    version,
    scope: shareItem.shareScope || 'default',
    shareConfig: {
      import: shareItem.import,
      singleton: shareItem.singleton || false,
      eager: shareItem.eager || false,
      requiredVersion,
      strictVersion: !!shareItem.strictVersion,
      ...(shareItem.request !== undefined ? { request: shareItem.request } : {}),
      ...(shareItem.shareKey !== undefined ? { shareKey: shareItem.shareKey } : {}),
      ...(shareItem.allowNodeModulesSuffixMatch !== undefined
        ? { allowNodeModulesSuffixMatch: shareItem.allowNodeModulesSuffixMatch }
        : {}),
      ...(shareItem.suppressMissingImportWarning ? { suppressMissingImportWarning: true } : {}),
      ...(treeShaking ? { treeShaking: { ...treeShaking } } : {}),
    },
  };
  sharedVersionConfigs.set(result, { ...config });
  return result;
}

/**
 * Trailing-slash keys are package namespace prefixes (`lodash/`, `@scope/ui/`).
 *
 * Packages in COMMON_SHARED_SUBPATHS historically collapsed `pkg/` → `pkg` so
 * Vite would not resolve the invalid `pkg/` specifier, while still auto-mapping
 * known subpaths when a local provider exists.
 *
 * `react/` is different: consumer-only shares need true namespace coverage for
 * any actually-imported subpath, not a hardcoded export list. Keep `react/` as
 * a prefix; concrete subpaths materialize on import via the generic matcher.
 *
 * `react-dom/` must keep collapsing. A browser-wide `react-dom/` prefix would
 * also capture `react-dom/server*`. Browser-safe entries (`react-dom/client`,
 * `react-dom/profiling`) stay via COMMON_SHARED_SUBPATHS (local provider) or
 * an exact shared key; SSR server* entries need an explicit shared key.
 */
function normalizeSharedKey(key: string): string {
  if (!key.endsWith('/')) return key;
  const baseKey = key.slice(0, -1);
  if (baseKey === 'react') return key;
  return getCommonSharedSubpaths(baseKey).length > 0 ? baseKey : key;
}

function normalizeShared(
  shared:
    | string[]
    | Record<
        string,
        | string
        | {
            name?: string;
            import?: moduleFederationPlugin.SharedConfig['import'];
            version?: string;
            shareScope?: string;
            request?: moduleFederationPlugin.SharedConfig['request'];
            shareKey?: moduleFederationPlugin.SharedConfig['shareKey'];
            singleton?: boolean;
            eager?: boolean;
            requiredVersion?: moduleFederationPlugin.SharedConfig['requiredVersion'];
            strictVersion?: boolean;
            allowNodeModulesSuffixMatch?: boolean;
            /** Suppress the missing local dependency warning for `import: false` shares. */
            suppressMissingImportWarning?: boolean;
            treeShaking?: TreeShakingConfig;
          }
      >
    | undefined
): NormalizedShared {
  explicitSharedKeys = new Set();
  if (!shared) return {};
  const result: NormalizedShared = {};
  const sourceEntries: Array<[string, string | Record<string, any>]> = [];
  if (Array.isArray(shared)) {
    shared.forEach((key) => {
      if (isModuleFederationRuntimePackage(key)) return;
      const normalizedKey = normalizeSharedKey(key);
      const hadConfiguredPackageSubpath =
        (result[normalizedKey]?.shareConfig as any)?.__mfConfiguredPackageSubpath === true;
      result[normalizedKey] = normalizeShareItem(normalizedKey, normalizedKey);
      if (key.endsWith('/') || hadConfiguredPackageSubpath) {
        (result[normalizedKey].shareConfig as any).__mfConfiguredPackageSubpath = true;
      }
      explicitSharedKeys.add(normalizedKey);
      sourceEntries.push([normalizedKey, normalizedKey]);
    });
  } else if (typeof shared === 'object') {
    Object.keys(shared).forEach((key) => {
      if (isModuleFederationRuntimePackage(key)) return;
      const normalizedKey = normalizeSharedKey(key);
      const value = shared[key] as any;
      const hadConfiguredPackageSubpath =
        (result[normalizedKey]?.shareConfig as any)?.__mfConfiguredPackageSubpath === true;
      result[normalizedKey] = normalizeShareItem(normalizedKey, value);
      if (key.endsWith('/') || hadConfiguredPackageSubpath) {
        (result[normalizedKey].shareConfig as any).__mfConfiguredPackageSubpath = true;
      }
      explicitSharedKeys.add(normalizedKey);
      sourceEntries.push([normalizedKey, value]);
    });
  }

  sourceEntries.forEach(([key, value]) => {
    for (const subpathShare of getLitExportSubpathShares(key)) {
      if (result[subpathShare]) continue;
      result[subpathShare] = normalizeShareItem(subpathShare, value as any);
    }
  });

  return result;
}

function isModuleFederationRuntimePackage(key: string): boolean {
  return key === '@module-federation/runtime' || key === '@module-federation/runtime-core';
}

function normalizeLibrary(library: any): any {
  if (!library) return undefined;
  return library;
}

export interface PluginManifestOptions {
  filePath?: string;
  disableAssetsAnalyze?: boolean;
  fileName?: string;
  additionalData?: (options: {
    stats: Record<string, unknown>;
    manifest?: Record<string, unknown>;
    pluginOptions: Record<string, unknown>;
    compiler?: unknown;
    compilation?: unknown;
    bundler: 'vite';
  }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}
function normalizeManifest(manifest: ModuleFederationOptions['manifest']) {
  if (manifest === undefined) {
    return undefined;
  }
  if (typeof manifest === 'boolean') {
    return manifest;
  }
  return {
    ...manifest,
    fileName: manifest.fileName || 'mf-manifest.json',
  };
}

function normalizeExperiments(
  experiments: ModuleFederationOptions['experiments']
): NormalizedExperimentsOptions {
  return {
    externalRuntime: experiments?.externalRuntime === true,
    provideExternalRuntime: experiments?.provideExternalRuntime === true,
    ssrMode: experiments?.ssrMode === 'ISLAND' ? 'ISLAND' : undefined,
  };
}

function normalizeSsrEntryLoader(
  ssrEntryLoader: ModuleFederationOptions['ssrEntryLoader']
): SsrEntryLoaderConfig | undefined {
  const strategy = ssrEntryLoader?.strategy;
  if (strategy !== 'temp-file' && strategy !== 'vm') return undefined;
  return { strategy };
}

export type ModuleFederationOptions = {
  exposes?: Record<string, string | { import: string }> | undefined;
  filename?: string;
  /**
   * Exact file name of the SSR remote entry emitted next to `filename`.
   * Defaults to `<filename base>.ssr<ext>` so it never clobbers the browser
   * entry when both builds share an output directory. `[hash]` is not supported.
   */
  ssrFilename?: string;
  library?: any;
  name: string;
  // remoteType?: string;
  remotes?: Record<string, string | RemoteObjectConfig> | undefined;
  runtime?: any;
  shareScope?: string | string[];
  /**
   * Override the public path used for remote entries
   * Defaults to Vite's base config or "auto" if base is empty
   */
  publicPath?: string;
  /**
   * Controls whether all CSS assets from the bundle should be added to every exposed module.
   * When false (default), the plugin will not process any CSS assets.
   * When true, all CSS assets are bundled into every exposed module.
   */
  bundleAllCSS?: boolean;
  /** Directory reserved for deploy-service generated secondary shared artifacts. */
  treeShakingDir?: string;
  /** Whether inferred usedExports metadata is injected into generated runtime records. */
  injectTreeShakingUsedExports?: boolean;
  treeShakingSharedPlugins?: string[];
  treeShakingSharedExcludePlugins?: string[];
  shared?:
    | string[]
    | Record<
        string,
        | string
        | {
            name?: string;
            version?: string;
            shareScope?: string;
            request?: moduleFederationPlugin.SharedConfig['request'];
            shareKey?: moduleFederationPlugin.SharedConfig['shareKey'];
            singleton?: boolean;
            eager?: boolean;
            requiredVersion?: moduleFederationPlugin.SharedConfig['requiredVersion'];
            strictVersion?: boolean;
            allowNodeModulesSuffixMatch?: boolean;
            /** Suppress the missing local dependency warning for `import: false` shares. */
            suppressMissingImportWarning?: boolean;
            treeShaking?: TreeShakingConfig;
            import?: moduleFederationPlugin.SharedConfig['import'];
          }
      >
    | undefined;
  runtimePlugins?: Array<string | [string, Record<string, unknown>]>;
  getPublicPath?: string;
  implementation?: string;
  manifest?: PluginManifestOptions | boolean;
  dev?: boolean | PluginDevOptions;
  dts?: boolean | PluginDtsOptions;
  shareStrategy?: ShareStrategy;
  ignoreOrigin?: boolean;
  virtualModuleDir?: string;
  hostInitInjectLocation?: HostInitInjectLocationOptions;
  /**
   * Timeout for parsing modules in seconds.
   * Defaults to 10 seconds.
   */
  moduleParseTimeout?: number;
  /**
   * Idle timeout for parsing modules in seconds. When set, the timeout resets
   * on every parsed module and only fires when there has been no module activity
   * for the configured duration. Prefer this over `moduleParseTimeout` for large
   * codebases where the total build time may exceed the fixed timeout.
   */
  moduleParseIdleTimeout?: number;
  /**
   * Allows generate additional remoteEntry file for "var" host environment
   */
  varFilename?: string;
  /**
   * Target environment for the build to enable effective tree-shaking.
   *
   * @see https://module-federation.io/configure/experiments#target
   * @default 'web' (or 'node' if build.ssr is enabled)
   */
  target?: 'web' | 'node';
  /**
   * Removes remote-consumption support from the federation runtime.
   * Only enable this for builds that never load remotes.
   *
   * @default false
   */
  disableRemote?: boolean;
  /**
   * Removes shared-dependency support from the federation runtime.
   * Only enable this when the build has no shared dependencies.
   *
   * @default false
   */
  disableShared?: boolean;
  /**
   * Removes snapshot support, including manifest-based remotes, preload,
   * dynamic type hints, HMR, and devtools integration.
   *
   * @default false (true for Node/SSR builds)
   */
  disableSnapshot?: boolean;
  /**
   * Additional packages to mark as external in the SSR remote entry build.
   * Shared packages and MF runtime packages are external by default. Use this to
   * add any other Node-only packages that should not be bundled into the SSR entry.
   * To emit a self-contained SSR entry (loadable by hosts that cannot resolve the
   * MF runtime from Node, such as the `@module-federation/sdk` reference loader),
   * opt the MF runtime packages back in through Vite's `ssr.noExternal`.
   */
  ssrExternals?: string[];
  /**
   * Options for the auto-injected `@module-federation/vite/ssrEntryLoader`.
   * When omitted, the loader uses the `'temp-file'` strategy. Set
   * `strategy: 'vm'` to opt into `vm.SourceTextModule` evaluation while keeping
   * the computed `resolvedShared` map.
   */
  ssrEntryLoader?: SsrEntryLoaderConfig;
  /**
   * Experimental Module Federation capabilities.
   *
   * @see https://module-federation.io/configure/experiments
   */
  experiments?: PluginExperimentsOptions;
};

export interface PluginExperimentsOptions {
  /**
   * Treat `@module-federation/runtime-core` as an external that reads
   * `globalThis._FEDERATION_RUNTIME_CORE` at runtime. Pair with a host that
   * sets `provideExternalRuntime: true`.
   */
  externalRuntime?: boolean;
  /**
   * Injects a local runtime plugin that publishes `runtime-core` on
   * `globalThis._FEDERATION_RUNTIME_CORE`. Set it on exactly one container
   * per page; that container may also `exposes`.
   */
  provideExternalRuntime?: boolean;
  /** Generate the React SSR/hydration island capability for eligible exposes. */
  ssrMode?: 'ISLAND';
}

export type SsrEntryLoaderStrategy = 'temp-file' | 'vm';

export type SsrEntryLoaderConfig = {
  /**
   * How the auto-injected `@module-federation/vite/ssrEntryLoader` evaluates
   * remote SSR entries.
   *
   * - `'temp-file'` (default when omitted): fetch the ESM graph, rewrite
   *   specifiers, write temp files and `import()` them.
   * - `'vm'`: evaluate the graph with `vm.SourceTextModule`. Requires
   *   `--experimental-vm-modules`; the loader emits a single warning and
   *   falls back to `'temp-file'` when that API is unavailable.
   */
  strategy?: SsrEntryLoaderStrategy;
};

export interface NormalizedExperimentsOptions {
  externalRuntime: boolean;
  provideExternalRuntime: boolean;
  ssrMode: 'ISLAND' | undefined;
}

export interface NormalizedModuleFederationOptions extends Omit<
  ModuleFederationOptions,
  'exposes' | 'remotes' | 'shared' | 'experiments'
> {
  exposes: Record<string, ExposesItem>;
  filename: string;
  ssrFilename?: string;
  internalName: string;
  library: any;
  remotes: Record<string, RemoteObjectConfig>;
  runtime: any;
  shareScope: string | string[];
  shared: NormalizedShared;
  runtimePlugins: Array<string | [string, Record<string, unknown>]>;
  implementation: string;
  manifest?: PluginManifestOptions | boolean;
  shareStrategy: ShareStrategy;
  virtualModuleDir: string;
  hostInitInjectLocation: HostInitInjectLocationOptions;
  bundleAllCSS: boolean;
  moduleParseTimeout: number;
  moduleParseIdleTimeout?: number;
  experiments: NormalizedExperimentsOptions;
}

type HostInitInjectLocationOptions = 'entry' | 'html';

interface PluginDevOptions {
  disableLiveReload?: boolean;
  disableHotTypesReload?: boolean;
  disableDynamicRemoteTypeHints?: boolean;
  /**
   * Controls cross-federation HMR for remote modules.
   *
   * - `false` / `undefined` — HMR disabled (default).
   * - `true` — HMR enabled with auto-detected strategy. When a framework
   *   plugin with cross-federation HMR support is detected, broadcast/relay
   *   is suppressed and the framework's native HMR handles updates:
   *     - React (`@vitejs/plugin-react` / `@vitejs/plugin-react-swc`) — the
   *       plugin serves a `/@react-refresh` proxy on remotes that delegates
   *       to the host's `RefreshRuntime`, unifying the component registry.
   *     - Vue (`@vitejs/plugin-vue` / `@vitejs/plugin-vue-jsx`) — the plugin
   *       injects a `__VUE_HMR_RUNTIME__` guard into the host page so the
   *       first-loaded (host) Vue runtime is pinned and remote-loaded Vue
   *       copies cannot overwrite it.
   *   For any host, the plugin also injects a script that clears the
   *   federation `moduleCache` on `vite:beforeUpdate` so subsequent
   *   `loadRemote()` calls return the freshly patched module.
   *   Other frameworks fall back to full page reloads.
   * - `'full-reload'` — HMR enabled, always use full page reloads even when
   *   a framework with native cross-federation HMR is detected.
   */
  remoteHmr?: boolean | 'full-reload';
}

interface RemoteTypeUrl {
  alias?: string;
  api: string;
  zip: string;
}

interface RemoteTypeUrls {
  [remoteName: string]: RemoteTypeUrl;
}

interface PluginDtsOptions {
  generateTypes?: boolean | DtsRemoteOptions;
  consumeTypes?: boolean | DtsHostOptions;
  tsConfigPath?: string;
  extraOptions?: Record<string, unknown>;
  implementation?: string;
  cwd?: string;
  displayErrorInTerminal?: boolean;
}

interface DtsRemoteOptions {
  tsConfigPath?: string;
  typesFolder?: string;
  compiledTypesFolder?: string;
  deleteTypesFolder?: boolean;
  additionalFilesToCompile?: string[];
  compilerInstance?: 'tsc' | 'vue-tsc' | 'tspc' | string;
  compileInChildProcess?: boolean;
  generateAPITypes?: boolean;
  extractThirdParty?:
    | boolean
    | {
        exclude?: Array<string | RegExp>;
      };
  extractRemoteTypes?: boolean;
  abortOnError?: boolean;
  deleteTsConfig?: boolean;
}

interface DtsHostOptions {
  typesFolder?: string;
  abortOnError?: boolean;
  remoteTypesFolder?: string;
  deleteTypesFolder?: boolean;
  maxRetries?: number;
  consumeAPITypes?: boolean;
  runtimePkgs?: string[];
  remoteTypeUrls?: (() => Promise<RemoteTypeUrls>) | RemoteTypeUrls;
  timeout?: number;
  family?: 0 | 4 | 6;
  typesOnBuild?: boolean;
}

let config: NormalizedModuleFederationOptions;
let explicitSharedKeys: Set<string> = new Set();
const explicitSharedKeysByOptions = new WeakMap<NormalizedModuleFederationOptions, Set<string>>();

function resolveRuntimeImplementation(): string {
  const fallback = resolveImportPath('@module-federation/runtime');

  try {
    const packageJsonPath = resolveImportPath('@module-federation/runtime/package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      module?: string;
      exports?: {
        '.'?:
          | string
          | {
              import?: string | { default?: string };
            };
      };
    };
    const importExport = packageJson.exports?.['.'];
    const exportImport =
      typeof importExport === 'object'
        ? typeof importExport.import === 'string'
          ? importExport.import
          : importExport.import?.default
        : undefined;
    const esmEntry = packageJson.module || exportImport;

    if (esmEntry) return path.join(path.dirname(packageJsonPath), esmEntry);
  } catch {
    // Fall back to Node's CJS resolver for older/nonstandard runtime packages.
  }

  return fallback;
}

export function getNormalizeModuleFederationOptions() {
  return config;
}

export function hasRemotes(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return Object.keys(options.remotes || {}).length > 0;
}

export function hasShared(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return Object.keys(options.shared || {}).length > 0;
}

export function isRemoteContainer(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return Object.keys(options.exposes || {}).length > 0;
}

export function isRemoteOnlyContainer(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return isRemoteContainer(options) && !hasRemotes(options);
}

export function isLocalOnlyContainer(
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  return !isRemoteContainer(options) && !hasRemotes(options);
}

export function isExplicitSharedKey(key: string, options?: NormalizedModuleFederationOptions) {
  return (
    (options ? explicitSharedKeysByOptions.get(options) : explicitSharedKeys)?.has(key) ?? false
  );
}

export function getNormalizeShareItem(
  key: string,
  options: NormalizedModuleFederationOptions = getNormalizeModuleFederationOptions()
) {
  // Registration must reuse the same prefix match as import interception.
  const matchedKey = findSharedKey(key, options.shared);
  const shareItem =
    options.shared[key] ||
    (matchedKey ? options.shared[matchedKey] : undefined) ||
    options.shared[getPackageName(key)] ||
    options.shared[getPackageName(key) + '/'];
  if (shareItem) return shareItem;

  // Generated runtime maps are keyed by shareKey rather than by the
  // user-facing shared config key. Recover the original item for aliases and
  // concrete prefix entries so all downstream code uses the same metadata.
  return Object.entries(options.shared).find(([sharedKey, item]) => {
    const runtimeKey =
      typeof item.shareConfig.shareKey === 'string' ? item.shareConfig.shareKey : sharedKey;
    return runtimeKey.endsWith('/')
      ? key === runtimeKey.slice(0, -1) || key.startsWith(runtimeKey)
      : runtimeKey === key;
  })?.[1];
}

export function normalizeModuleFederationOptions(
  options: ModuleFederationOptions
): NormalizedModuleFederationOptions {
  warnOnReservedInternalNamePrefix(options.name, 'containerName');
  if (options.virtualModuleDir && options.virtualModuleDir.includes('/')) {
    throw createModuleFederationError(
      `Invalid virtualModuleDir: "${options.virtualModuleDir}". ` +
        `The virtualModuleDir option cannot contain slashes (/). ` +
        `Please use a single directory name like '__mf__virtual__your_app_name'.`
    );
  }

  const normalized: NormalizedModuleFederationOptions = {
    exposes: normalizeExposes(options.exposes),
    filename: options.filename || 'remoteEntry-[hash]',
    ssrFilename: options.ssrFilename || undefined,
    internalName: toInternalModuleFederationName(options.name),
    library: normalizeLibrary(options.library),
    name: options.name,
    // remoteType: options.remoteType,
    remotes: normalizeRemotes(options.remotes),
    runtime: options.runtime,
    shareScope: options.shareScope || 'default',
    shared: normalizeShared(options.shared),
    runtimePlugins: options.runtimePlugins || [],
    implementation: normalizePathForImport(
      options.implementation || resolveRuntimeImplementation()
    ),
    manifest: normalizeManifest(options.manifest),
    dev: options.dev,
    dts: options.dts,
    getPublicPath: options.getPublicPath,
    publicPath: options.publicPath,
    shareStrategy: options.shareStrategy || 'version-first',
    ignoreOrigin: options.ignoreOrigin || false,
    virtualModuleDir: options.virtualModuleDir || '__mf__virtual',
    hostInitInjectLocation: options.hostInitInjectLocation || 'html',
    bundleAllCSS: options.bundleAllCSS || false,
    treeShakingDir: options.treeShakingDir,
    injectTreeShakingUsedExports: options.injectTreeShakingUsedExports,
    treeShakingSharedPlugins: options.treeShakingSharedPlugins,
    treeShakingSharedExcludePlugins: options.treeShakingSharedExcludePlugins,
    moduleParseTimeout: options.moduleParseTimeout ?? 10,
    moduleParseIdleTimeout: options.moduleParseIdleTimeout,
    varFilename: options.varFilename,
    target: options.target,
    ssrExternals: options.ssrExternals,
    ssrEntryLoader: normalizeSsrEntryLoader(options.ssrEntryLoader),
    disableRemote: options.disableRemote,
    disableShared: options.disableShared,
    disableSnapshot: options.disableSnapshot,
    experiments: normalizeExperiments(options.experiments),
  };
  if (normalized.experiments.ssrMode === 'ISLAND' && Object.hasOwn(normalized.shared, 'react')) {
    mfWarn(
      'Island expose generation is disabled because experiments.ssrMode is "ISLAND" and React is configured as shared. ' +
        'Remove "react" from shared to generate island exposes, or remove ssrMode to use standard shared rendering.'
    );
  }
  explicitSharedKeysByOptions.set(normalized, new Set(explicitSharedKeys));
  return (config = normalized);
}
