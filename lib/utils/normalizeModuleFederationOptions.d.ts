import { SharedConfig } from '@module-federation/runtime/types';
export type RemoteEntryType = 'var' | 'module' | 'assign' | 'assign-properties' | 'this' | 'window' | 'self' | 'global' | 'commonjs' | 'commonjs2' | 'commonjs-module' | 'commonjs-static' | 'amd' | 'amd-require' | 'umd' | 'umd2' | 'jsonp' | 'system' | string;
interface ExposesItem {
    import: string;
}
export interface NormalizedShared {
    [key: string]: ShareItem;
}
export declare function normalizeRemotes(remotes: Record<string, string | {
    type: string;
    name: string;
    entry: string;
    entryGlobalName: string;
    shareScope: string;
}> | undefined): Record<string, {
    type: string;
    name: string;
    entry: string;
    entryGlobalName: string;
    shareScope: string;
}>;
export interface ShareItem {
    name: string;
    version: string | undefined;
    scope: string;
    from: string;
    shareConfig: SharedConfig;
}
interface ManifestOptions {
    filePath?: string;
    disableAssetsAnalyze?: boolean;
    fileName?: string;
}
export type ModuleFederationOptions = {
    exposes?: Record<string, string | {
        import: string;
    }> | undefined;
    filename?: string;
    library?: any;
    name: string;
    remotes?: Record<string, string | {
        type: string;
        name: string;
        entry: string;
        entryGlobalName: string;
        shareScope: string;
    }> | undefined;
    runtime?: any;
    shareScope?: string;
    shared?: string[] | Record<string, string | {
        name?: string;
        version?: string;
        shareScope?: string;
        singleton?: boolean;
        requiredVersion?: string;
        strictVersion?: boolean;
    }> | undefined;
    runtimePlugins?: string[];
    getPublicPath?: any;
    implementation?: any;
    manifest?: ManifestOptions | boolean;
    dev?: any;
    dts?: any;
};
export interface NormalizedModuleFederationOptions {
    exposes: Record<string, ExposesItem>;
    filename: string;
    library: any;
    name: string;
    remotes: Record<string, {
        type: string;
        name: string;
        entry: string;
        entryGlobalName: string;
        shareScope: string;
    }>;
    runtime: any;
    shareScope: string;
    shared: NormalizedShared;
    runtimePlugins: string[];
    getPublicPath: any;
    implementation: any;
    manifest: ManifestOptions | boolean;
    dev: any;
    dts: any;
}
export declare function getNormalizeModuleFederationOptions(): NormalizedModuleFederationOptions;
export declare function getNormalizeShareItem(key: string): ShareItem;
export declare function normalizeModuleFederationOptions(options: ModuleFederationOptions): NormalizedModuleFederationOptions;
export {};
