import { SharedConfig, ShareStrategy } from '@module-federation/runtime/types';

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
  shareConfig: SharedConfig;
}

function removePathFromNpmPackage(packageString: string): string {
  // 匹配npm包名的正则表达式，忽略路径部分
  const regex = /^(?:@[^/]+\/)?[^/]+/;

  // 使用正则表达式匹配并提取包名
  const match = packageString.match(regex);

  // 返回匹配到的包名，如果没有匹配到则返回原字符串
  return match ? match[0] : packageString;
}

function normalizeShareItem(
  key: string,
  shareItem:
    | string
    | {
        name: string;
        version?: string;
        shareScope?: string;
        singleton?: boolean;
        requiredVersion?: string;
        strictVersion?: boolean;
      }
): ShareItem {
  let version: string | undefined;
  try {
    version = require(path.join(removePathFromNpmPackage(key), 'package.json')).version;
  } catch (e) {
    console.log(e);
  }
  if (typeof shareItem === 'string') {
    return {
      name: shareItem,
      version,
      scope: 'default',
      from: '',
      shareConfig: {
        singleton: false,
        requiredVersion: `^${version}` || '*',
      },
    };
  }
  return {
    name: key,
    from: '',
    version: shareItem.version || version,
    scope: shareItem.shareScope || 'default',
    shareConfig: {
      singleton: shareItem.singleton || false,
      requiredVersion: shareItem.requiredVersion || `^${version}` || '*',
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
          }
      >
    | undefined;
  runtimePlugins?: string[];
  getPublicPath?: any;
  implementation?: any;
  manifest?: ManifestOptions | boolean;
  dev?: any;
  dts?: any;
  shareStrategy: ShareStrategy;
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
  runtimePlugins: string[];
  getPublicPath: any;
  implementation: any;
  manifest: ManifestOptions | boolean;
  dev: any;
  dts: any;
  shareStrategy?: ShareStrategy;
}

let config: NormalizedModuleFederationOptions;
export function getNormalizeModuleFederationOptions() {
  return config;
}

export function getNormalizeShareItem(key: string) {
  const options = getNormalizeModuleFederationOptions();
  const shareItem =
    options.shared[removePathFromNpmPackage(key)] ||
    options.shared[removePathFromNpmPackage(key) + '/'];
  return shareItem;
}

export function normalizeModuleFederationOptions(
  options: ModuleFederationOptions
): NormalizedModuleFederationOptions {
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
    getPublicPath: options.getPublicPath,
    implementation: options.implementation,
    manifest: normalizeManifest(options.manifest),
    dev: options.dev,
    dts: options.dts,
    shareStrategy: options.shareStrategy,
  });
}
