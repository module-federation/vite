import { SharedConfig } from "@module-federation/runtime/types";

export type RemoteEntryType = 'var' | 'module' | 'assign' | 'assign-properties' | 'this' | 'window' | 'self' | 'global' | 'commonjs' | 'commonjs2' | 'commonjs-module' | 'commonjs-static' | 'amd' | 'amd-require' | 'umd' | 'umd2' | 'jsonp' | 'system' | string;

import path from "path";

interface ExposesItem {
  import: string;
}
export interface NormalizedShared {
  [key: string]: ShareItem
}

function normalizeExposesItem(key: string, item: string | { import: string }): ExposesItem {
  let importPath: string = "";
  if (typeof item === "string") {
    importPath = item;
  }
  if (typeof item === "object") {
    importPath = item.import;
  }
  return {
    import: importPath
  };
}

function normalizeExposes(exposes: Record<string, string | { import: string }> | undefined): Record<string, ExposesItem> {
  if (!exposes) return {};
  const res: Record<string, ExposesItem> = {};
  Object.keys(exposes).forEach(key => {
    res[key] = normalizeExposesItem(key, exposes[key]);
  });
  return res;
}

export function normalizeRemotes(remotes: Record<string, string | { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string }> | undefined): Record<string, { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string }> {
  if (!remotes) return {};
  const result: Record<string, { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string }> = {};
  if (typeof remotes === "object") {
    Object.keys(remotes).forEach(key => {
      result[key] = normalizeRemoteItem(key, remotes[key]);
    });
  }
  return result;
}

function normalizeRemoteItem(key: string, remote: string | { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string }): { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string } {
  if (typeof remote === "string") {
    const [entryGlobalName] = remote.split("@");
    const entry = remote.replace(entryGlobalName + "@", "");
    return {
      type: "var",
      name: key,
      entry,
      entryGlobalName,
      shareScope: "default"
    };
  }
  return Object.assign({
    type: "var",
    name: key,
    shareScope: "default",
    entryGlobalName: key,
  }, remote);
}

interface ShareItem {
  name: string;
  version: string | undefined;
  scope: string;
  from: string;
  shareConfig: SharedConfig
}

function normalizeShareItem(key: string, shareItem: string | { name: string; version?: string; shareScope?: string; singleton?: boolean; requiredVersion?: string; strictVersion?: boolean }): ShareItem {
  let version: string | undefined;
  try {
    version = require(path.join(key, "package.json")).version;
  } catch (e) {
    console.log(e);
  }
  if (typeof shareItem === "string") {
    return {
      name: shareItem,
      version,
      scope: "default",
      from: "",
      shareConfig: {
        singleton: false,
        requiredVersion: version || "*"
      }
    };
  }
  return {
    name: key,
    from: "",
    version: shareItem.version || version,
    scope: shareItem.shareScope || "default",
    shareConfig: {
      singleton: shareItem.singleton || false,
      requiredVersion: shareItem.requiredVersion || version || "*",
      strictVersion: !!shareItem.strictVersion,
    }
  };
}

function normalizeShared(shared: string[] | Record<string, string | { name: string; version?: string; shareScope?: string; singleton?: boolean; requiredVersion?: string; strictVersion?: boolean }> | undefined): NormalizedShared {
  if (!shared) return {};
  const result: NormalizedShared = {};
  if (Array.isArray(shared)) {
    shared.forEach(key => {
      result[key] = normalizeShareItem(key, key);
    });
    return result;
  }
  if (typeof shared === "object") {
    Object.keys(shared).forEach(key => {
      result[key] = normalizeShareItem(key, shared[key]);
    });
  }

  return result;
}

function normalizeLibrary(library: any): any {
  if (!library) return undefined;
  return library;
}

export type ModuleFederationOptions = {
  exposes: Record<string, string | { import: string }> | undefined;
  filename?: string;
  library: any;
  name: string;
  remoteType: string;
  remotes: Record<string, string | { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string }> | undefined;
  runtime: any;
  shareScope?: string;
  shared: string[] | Record<string, string | { name: string; version?: string; shareScope?: string; singleton?: boolean; requiredVersion?: string; strictVersion?: boolean }> | undefined;
  runtimePlugins: any;
  getPublicPath: any;
  implementation: any;
  manifest: any;
  dev: any;
  dts: any;
}

export interface NormalizedModuleFederationOptions {
  exposes: Record<string, ExposesItem>;
  filename: string;
  library: any;
  name: string;
  remoteType: string;
  remotes: Record<string, { type: string; name: string; entry: string; entryGlobalName: string; shareScope: string }>;
  runtime: any;
  shareScope: string;
  shared: NormalizedShared;
  runtimePlugins: any;
  getPublicPath: any;
  implementation: any;
  manifest: any;
  dev: any;
  dts: any;
}

export function normalizeModuleFederationOptions(options: ModuleFederationOptions): NormalizedModuleFederationOptions {
  return {
    exposes: normalizeExposes(options.exposes),
    filename: options.filename || "remoteEntry.js",
    library: normalizeLibrary(options.library),
    name: options.name,
    remoteType: options.remoteType,
    remotes: normalizeRemotes(options.remotes),
    runtime: options.runtime,
    shareScope: options.shareScope || "default",
    shared: normalizeShared(options.shared),
    runtimePlugins: options.runtimePlugins,
    getPublicPath: options.getPublicPath,
    implementation: options.implementation,
    manifest: options.manifest,
    dev: options.dev,
    dts: options.dts
  };
}