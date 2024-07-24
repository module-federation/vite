declare module 'module-federation-vite' {
  type RemoteEntryType = 'var' | 'module' | 'assign' | 'assign-properties' | 'this' | 'window' | 'self' | 'global' | 'commonjs' | 'commonjs2' | 'commonjs-module' | 'commonjs-static' | 'amd' | 'amd-require' | 'umd' | 'umd2' | 'jsonp' | 'system' | string;
  interface Remote {
    entryGlobalName?: string;
    entry: string;
    type?: RemoteEntryType;
    shareScope?: string;
  }

  interface Remotes {
    [key: string]: string | Remote;
  }

  interface Shared {
    [key: string]: {
      requiredVersion?: string;
      strictVersion?: boolean;
      singleton?: boolean;
    } | boolean;
  }

  interface ModuleFederationPluginOptions {
    name: string;
    remotes: Remotes;
    exposes: {
      [key: string]: string;
    };
    filename: string;
    shared?: string[] | Shared;
  }

  function fe(options: ModuleFederationPluginOptions): any;

  export = fe;
}