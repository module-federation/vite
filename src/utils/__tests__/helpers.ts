import type { NormalizedModuleFederationOptions } from '../normalizeModuleFederationOptions';

export function getDefaultMockOptions(
  overrides: Partial<NormalizedModuleFederationOptions> = {}
): NormalizedModuleFederationOptions {
  return {
    exposes: {},
    filename: 'remoteEntry.js',
    library: {},
    name: 'test',
    remotes: {},
    runtime: {},
    shareScope: 'default',
    shared: {},
    runtimePlugins: [],
    implementation: require.resolve('@module-federation/runtime'),
    manifest: false,
    shareStrategy: 'loaded-first',
    virtualModuleDir: '__mf__virtual',
    ...overrides,
  };
}
