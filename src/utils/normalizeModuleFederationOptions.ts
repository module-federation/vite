import { SharedConfig, ShareStrategy } from '@module-federation/runtime/types';
import type { sharePlugin } from '@module-federation/sdk';

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
import * as path from 'pathe';

interface ExposesItem {
  import: string;
}
export interface NormalizedShared {
  [key: string]: ShareItem;
}
export interface RemoteObjectConfig {
  type?: string;
  name: string;
  entry: string;
  entryGlobalName?: string;
  shareScope?: string;
}

function normalizeExposesItem(key: string, item: string | { import: string }): ExposesItem {
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
    res[key] = normalizeExposesItem(key, exposes[key]);
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

function normalizeRemoteItem(key: string, remote: string | RemoteObjectConfig): RemoteObjectConfig {
  if (typeof remote === 'string') {
    const [entryGlobalName] = remote.split('@');
    const entry = remote.replace(entryGlobalName + '@', '');
    return {
      type: 'var',
      name: key,
      entry,
      entryGlobalName,
      shareScope: 'default',
    };
  }
  return Object.assign(
    {
      type: 'var',
      name: key,
      shareScope: 'default',
      entryGlobalName: key,
    },
    remote
  );
}

export interface ShareItem {
  name: string;
  version: string | undefined;
  scope: string;
  from: string;
  shareConfig: SharedConfig & sharePlugin.SharedConfig;
}

function removePathFromNpmPackage(packageString: string): string {
  // 匹配npm包名的正则表达式，忽略路径部分
  const regex = /^(?:@[^/]+\/)?[^/]+/;

  // 使用正则表达式匹配并提取包名
  const match = packageString.match(regex);

  // 返回匹配到的包名，如果没有匹配到则返回原字符串
  return match ? match[0] : packageString;
}

/**
 * Tries to find the package.json's version of a shared package
 * if `package.json` is not declared in `exports`
 * @param {string} sharedName
 * @returns {string | undefined}
 */
function searchPackageVersion(sharedName: string): string | undefined {
  try {
    const sharedPath = require.resolve(sharedName);
    let potentialPackageJsonDir = path.dirname(sharedPath);
    const rootDir = path.parse(potentialPackageJsonDir).root;
    while (
      path.parse(potentialPackageJsonDir).base !== 'node_modules' &&
      potentialPackageJsonDir !== rootDir
    ) {
      const potentialPackageJsonPath = path.join(potentialPackageJsonDir, 'package.json');
      if (fs.existsSync(potentialPackageJsonPath)) {
        const potentialPackageJson = require(potentialPackageJsonPath);
        if (
          typeof potentialPackageJson == 'object' &&
          potentialPackageJson !== null &&
          typeof potentialPackageJson.version === 'string' &&
          potentialPackageJson.name === sharedName
        ) {
          return potentialPackageJson.version;
        }
      }
      potentialPackageJsonDir = path.dirname(potentialPackageJsonDir);
    }
  } catch (_) {}
  return undefined;
}

function normalizeShareItem(
  key: string,
  shareItem:
    | string
    | {
        name: string;
        import: sharePlugin.SharedConfig['import'];
        version?: string;
        shareScope?: string;
        singleton?: boolean;
        requiredVersion?: string;
        strictVersion?: boolean;
      }
): ShareItem {
  let version: string | undefined;
  try {
    try {
      version = require(path.join(removePathFromNpmPackage(key), 'package.json')).version;
    } catch (e1) {
      try {
        const localPath = path.join(
          process.cwd(),
          'node_modules',
          removePathFromNpmPackage(key),
          'package.json'
        );
        version = require(localPath).version;
      } catch (e2) {
        version = searchPackageVersion(key);
        if (!version) console.error(e1);
      }
    }
  } catch (e) {
    console.error(`Unexpected error resolving version for ${key}:`, e);
  }
  if (typeof shareItem === 'string') {
    return {
      name: shareItem,
      version,
      scope: 'default',
      from: '',
      shareConfig: {
        import: undefined,
        singleton: false,
        requiredVersion: version ? `^${version}` : '*',
      },
    };
  }
  return {
    name: key,
    from: '',
    version: shareItem.version || version,
    scope: shareItem.shareScope || 'default',
    shareConfig: {
      import: typeof shareItem === 'object' ? shareItem.import : undefined,
      singleton: shareItem.singleton || false,
      requiredVersion: shareItem.requiredVersion || (version ? `^${version}` : '*'),
      strictVersion: !!shareItem.strictVersion,
    },
  };
}

function normalizeShared(
  shared:
    | string[]
    | Record<
        string,
        | string
        | {
            name?: string;
            version?: string;
            shareScope?: string;
            singleton?: boolean;
            requiredVersion?: string;
            strictVersion?: boolean;
          }
      >
    | undefined
): NormalizedShared {
  if (!shared) return {};
  const result: NormalizedShared = {};
  if (Array.isArray(shared)) {
    shared.forEach((key) => {
      result[key] = normalizeShareItem(key, key);
    });
    return result;
  }
  if (typeof shared === 'object') {
    Object.keys(shared).forEach((key) => {
      result[key] = normalizeShareItem(key, shared[key] as any);
    });
  }

  return result;
}

function normalizeLibrary(library: any): any {
  if (!library) return undefined;
  return library;
}

interface ManifestOptions {
  filePath?: string;
  disableAssetsAnalyze?: boolean;
  fileName?: string;
}
function normalizeManifest(manifest: ModuleFederationOptions['manifest'] = false) {
  if (typeof manifest === 'boolean') {
    return manifest;
  }
  return Object.assign(
    {
      filePath: '',
      disableAssetsAnalyze: false,
      fileName: 'mf-manifest.json',
    },
    manifest
  );
}

export type ModuleFederationOptions = {
  exposes?: Record<string, string | { import: string }> | undefined;
  filename?: string;
  library?: any;
  name: string;
  // remoteType?: string;
  remotes?: Record<string, string | RemoteObjectConfig> | undefined;
  runtime?: any;
  shareScope?: string;
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
  shared?:
    | string[]
    | Record<
        string,
        | string
        | {
            name?: string;
            version?: string;
            shareScope?: string;
            singleton?: boolean;
            requiredVersion?: string;
            strictVersion?: boolean;
            import?: sharePlugin.SharedConfig['import'];
          }
      >
    | undefined;
  runtimePlugins?: Array<string | [string, Record<string, unknown>]>;
  getPublicPath?: string;
  implementation?: string;
  manifest?: ManifestOptions | boolean;
  dev?: boolean | PluginDevOptions;
  dts?: boolean | PluginDtsOptions;
  shareStrategy?: ShareStrategy;
  ignoreOrigin?: boolean;
  virtualModuleDir?: string;
  hostInitInjectLocation?: HostInitInjectLocationOptions;
};

export interface NormalizedModuleFederationOptions {
  exposes: Record<string, ExposesItem>;
  filename: string;
  library: any;
  name: string;
  // remoteType: string;
  remotes: Record<string, RemoteObjectConfig>;
  runtime: any;
  shareScope: string;
  shared: NormalizedShared;
  runtimePlugins: Array<string | [string, Record<string, unknown>]>;
  implementation: string;
  manifest: ManifestOptions | boolean;
  dev?: boolean | PluginDevOptions;
  dts?: boolean | PluginDtsOptions;
  shareStrategy: ShareStrategy;
  getPublicPath?: string;
  publicPath?: string;
  ignoreOrigin?: boolean;
  virtualModuleDir: string;
  hostInitInjectLocation: HostInitInjectLocationOptions;
  /**
   * Controls whether all CSS assets from the bundle should be added to every exposed module.
   * When false (default), the plugin will not process any CSS assets.
   * When true, all CSS assets are bundled into every exposed module.
   */
  bundleAllCSS: boolean;
}

type HostInitInjectLocationOptions = 'entry' | 'html';

interface PluginDevOptions {
  disableLiveReload?: boolean;
  disableHotTypesReload?: boolean;
  disableDynamicRemoteTypeHints?: boolean;
}

interface PluginDtsOptions {
  generateTypes?: boolean | DtsRemoteOptions;
  consumeTypes?: boolean | DtsHostOptions;
  tsConfigPath?: string;
}

interface DtsRemoteOptions {
  tsConfigPath?: string;
  typesFolder?: string;
  deleteTypesFolder?: boolean;
  additionalFilesToCompile?: string[];
  compilerInstance?: 'tsc' | 'vue-tsc';
  compileInChildProcess?: boolean;
  generateAPITypes?: boolean;
  extractThirdParty?: boolean;
  extractRemoteTypes?: boolean;
  abortOnError?: boolean;
}

interface DtsHostOptions {
  typesFolder?: string;
  abortOnError?: boolean;
  remoteTypesFolder?: string;
  deleteTypesFolder?: boolean;
  maxRetries?: number;
  consumeAPITypes?: boolean;
}

let config: NormalizedModuleFederationOptions;

export function getNormalizeModuleFederationOptions() {
  return config;
}

export function getNormalizeShareItem(key: string) {
  const options = getNormalizeModuleFederationOptions();
  const shareItem =
    options.shared[key] ||
    options.shared[removePathFromNpmPackage(key)] ||
    options.shared[removePathFromNpmPackage(key) + '/'];
  return shareItem;
}

export function normalizeModuleFederationOptions(
  options: ModuleFederationOptions
): NormalizedModuleFederationOptions {
  if (options.virtualModuleDir && options.virtualModuleDir.includes('/')) {
    throw new Error(
      `Invalid virtualModuleDir: "${options.virtualModuleDir}". ` +
        `The virtualModuleDir option cannot contain slashes (/). ` +
        `Please use a single directory name like '__mf__virtual__your_app_name'.`
    );
  }

  return (config = {
    exposes: normalizeExposes(options.exposes),
    filename: options.filename || 'remoteEntry-[hash]',
    library: normalizeLibrary(options.library),
    name: options.name,
    // remoteType: options.remoteType,
    remotes: normalizeRemotes(options.remotes),
    runtime: options.runtime,
    shareScope: options.shareScope || 'default',
    shared: normalizeShared(options.shared),
    runtimePlugins: options.runtimePlugins || [],
    implementation: options.implementation || require.resolve('@module-federation/runtime'),
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
  });
}
