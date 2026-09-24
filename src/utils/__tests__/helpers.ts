import Module from 'node:module';
import type { NormalizedModuleFederationOptions } from '../normalizeModuleFederationOptions';

export function getDefaultMockOptions(
  overrides: Partial<NormalizedModuleFederationOptions> = {}
): NormalizedModuleFederationOptions {
  return {
    exposes: {},
    filename: 'remoteEntry.js',
    internalName: '__mfe_internal__test',
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
    hostInitInjectLocation: 'html',
    bundleAllCSS: false,
    moduleParseTimeout: 10,
    experiments: {
      externalRuntime: false,
      provideExternalRuntime: false,
      ssrMode: undefined,
    },
    ...overrides,
  };
}

// Node reads NODE_PATH into its global lookup paths once, at startup.
function applyNodePath(nodePath: string | undefined) {
  if (nodePath === undefined) delete process.env.NODE_PATH;
  else process.env.NODE_PATH = nodePath;
  (Module as unknown as { _initPaths(): void })._initPaths();
}

export async function withNodePath<T>(nodePath: string, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.NODE_PATH;
  applyNodePath(nodePath);
  try {
    return await run();
  } finally {
    applyNodePath(previous);
  }
}
