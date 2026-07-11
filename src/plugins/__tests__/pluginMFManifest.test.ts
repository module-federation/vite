import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmitFile,
  NormalizedOutputOptions,
  OutputAsset,
  OutputBundle,
  OutputChunk,
  PluginContext,
  ResolvedId,
} from 'rollup';
import type {
  ConfigPluginContext,
  MinimalPluginContextWithoutEnvironment,
  ResolvedConfig,
} from 'vite';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

import manifestPlugin from '../pluginMFManifest';

const {
  getNormalizeModuleFederationOptions,
  getUsedRemotesMap,
  getUsedShares,
  getNormalizeShareItem,
  getPreBuildLibImportId,
} = vi.hoisted(() => ({
  getNormalizeModuleFederationOptions: vi.fn(),
  getUsedRemotesMap: vi.fn(),
  getUsedShares: vi.fn(),
  getNormalizeShareItem: vi.fn(),
  getPreBuildLibImportId: vi.fn((shareKey: string) => shareKey),
}));

vi.mock('../../utils/normalizeModuleFederationOptions', () => ({
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
}));

vi.mock('../../virtualModules', () => ({
  getUsedRemotesMap,
  getUsedShares,
  getPreBuildLibImportId,
}));

type RenderedModule = NonNullable<OutputChunk['modules']>[string];

function createRenderedModule(): RenderedModule {
  return {
    code: '',
    originalLength: 0,
    removedExports: [],
    renderedExports: [],
    renderedLength: 0,
  };
}

const makeBundle = (): OutputBundle => ({
  'remoteEntry.js': {
    type: 'chunk',
    fileName: 'remoteEntry.js',
    name: 'remoteEntry',
    facadeModuleId: '/src/remoteEntry.ts',
    code: 'const a = 1;',
    dynamicImports: [],
    implicitlyLoadedBefore: [],
    importedBindings: {},
    imports: [],
    isDynamicEntry: false,
    isEntry: true,
    isImplicitEntry: false,
    moduleIds: ['/src/exposed.js'],
    modules: {
      '/src/exposed.js': createRenderedModule(),
    },
    referencedFiles: [],
    exports: [],
    map: null,
    preliminaryFileName: 'remoteEntry.js',
    sourcemapFileName: null,
  } satisfies OutputChunk,
  'styles.css': {
    type: 'asset',
    fileName: 'styles.css',
    source: 'body {}',
    name: 'styles.css',
    names: ['styles.css'],
    needsCodeReference: false,
    originalFileNames: [],
    originalFileName: null,
  } satisfies OutputAsset,
});

type TestPluginContext = Pick<PluginContext, 'emitFile' | 'resolve'>;
type GenerateBundleHook = (
  this: PluginContext,
  outputOptions: NormalizedOutputOptions,
  bundle: OutputBundle,
  isWrite: boolean
) => void | Promise<void>;

function runGenerateBundle(
  plugin: ReturnType<typeof manifestPlugin>[1],
  ctx: TestPluginContext,
  bundle: OutputBundle
) {
  return callHook(
    plugin.generateBundle as unknown as GenerateBundleHook | { handler: GenerateBundleHook },
    ctx as PluginContext,
    {} as NormalizedOutputOptions,
    bundle,
    false
  );
}

async function runGenerateBundleWithManifest(
  manifestOptions: unknown,
  runtime: {
    usedShares?: Set<string>;
    usedRemotes?: Map<string, Set<string>> | Record<string, Set<string>>;
    exposePaths?: Record<string, { import: string }>;
    shareItems?: Record<
      string,
      | {
          version: string;
          shareConfig: { requiredVersion: string; singleton?: boolean };
        }
      | undefined
    >;
    dts?: unknown;
    filename?: string;
    varFilename?: string;
    remotes?: Record<
      string,
      { name: string; entry: string; entryGlobalName?: string; type?: string }
    >;
    bundle?: OutputBundle;
    environmentName?: string;
  } = {},
  command: 'serve' | 'build' = 'build',
  base = '/'
): Promise<Record<string, string>> {
  getNormalizeModuleFederationOptions.mockReturnValue({
    name: 'basicRemote',
    filename: runtime.filename || 'remoteEntry.js',
    getPublicPath: undefined,
    varFilename: runtime.varFilename,
    dts: runtime.dts,
    manifest: manifestOptions,
    exposes: runtime.exposePaths || {},
    remotes: runtime.remotes || {},
    shared: {},
    bundleAllCSS: false,
    shareStrategy: 'version-first',
    implementation: 'module-federation-runtime',
    runtimePlugins: [],
    virtualModuleDir: '__mf__virtual',
    hostInitInjectLocation: 'html',
    moduleParseTimeout: 10,
    ignoreOrigin: false,
  });
  getUsedRemotesMap.mockReturnValue(runtime.usedRemotes || new Map());
  getUsedShares.mockReturnValue(runtime.usedShares || new Set());
  getNormalizeShareItem.mockImplementation((shareKey: string) => {
    if (runtime.shareItems && Object.hasOwn(runtime.shareItems, shareKey)) {
      return runtime.shareItems[shareKey];
    }
    return {
      version: '1.0.0',
      shareConfig: { requiredVersion: '*' },
    };
  });

  const [, buildPlugin] = manifestPlugin();
  const emitted: Record<string, string> = {};

  callHook(buildPlugin.config, {} as ConfigPluginContext, base === '/' ? {} : { base }, {
    command,
    mode: 'test',
  });
  callHook(
    buildPlugin.configResolved,
    {} as MinimalPluginContextWithoutEnvironment,
    {
      root: '/',
      base,
      build: {},
      server: { origin: 'http://localhost' },
    } as unknown as ResolvedConfig
  );

  const emitFile: EmitFile = (asset) => {
    if ('fileName' in asset && typeof asset.fileName === 'string' && 'source' in asset) {
      emitted[asset.fileName] =
        typeof asset.source === 'string'
          ? asset.source
          : Buffer.from(asset.source ?? new Uint8Array()).toString('utf8');
      return `id:${asset.fileName}`;
    }
    return 'id:unknown';
  };
  const ctx: TestPluginContext = {
    emitFile,
    resolve: async (source) =>
      ({
        id: `/node_modules/${source}/index.js`,
        external: false,
      }) as ResolvedId,
  };

  if (runtime.environmentName) {
    Object.assign(ctx, { environment: { name: runtime.environmentName } });
  }

  await runGenerateBundle(buildPlugin, ctx, runtime.bundle || makeBundle());
  return emitted;
}

describe('pluginMFManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not emit the browser manifest in the ssr environment', async () => {
    const emitted = await runGenerateBundleWithManifest(true, { environmentName: 'ssr' });

    expect(emitted['mf-manifest.json']).toBeUndefined();
    expect(emitted['mf-stats.json']).toBeUndefined();
  });

  it('emits the browser manifest in the client environment', async () => {
    const emitted = await runGenerateBundleWithManifest(true, { environmentName: 'client' });

    expect(emitted['mf-manifest.json']).toBeDefined();
  });

  it('emits manifest and mf-stats artifacts by default', async () => {
    const emitted = await runGenerateBundleWithManifest(true);

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    const stats = JSON.parse(emitted['mf-stats.json']);

    expect(manifest).toHaveProperty('metaData');
    expect(stats).toHaveProperty('buildOutput');
    expect(
      stats.buildOutput.find((chunk: { fileName: string }) => chunk.fileName === 'remoteEntry.js')
    ).toBeTruthy();
  });

  it('points ssrRemoteEntry at the dedicated SSR entry filename', async () => {
    const emitted = await runGenerateBundleWithManifest(true);

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.metaData.remoteEntry).toMatchObject({
      name: 'remoteEntry.js',
      type: 'module',
    });
    expect(manifest.metaData.ssrRemoteEntry).toMatchObject({
      name: 'remoteEntry.ssr.js',
      type: 'module',
    });
  });

  it('identifies the production var remote entry as a var container', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {
      varFilename: 'remoteEntry.var.js',
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.metaData.varRemoteEntry).toEqual({
      name: 'remoteEntry.var.js',
      path: '',
      type: 'var',
    });
  });

  it('reports the remote container name separately from its entry URL', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {
      remotes: {
        catalog: {
          name: 'catalogContainer',
          entry: 'https://cdn.example.com/remoteEntry.js',
          type: 'module',
        },
      },
      usedRemotes: { catalog: new Set(['catalog/Product']) },
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.remotes).toContainEqual({
      federationContainerName: 'catalogContainer',
      moduleName: 'Product',
      alias: 'catalog',
      entry: '*',
    });
  });

  it('reports entryGlobalName for string-form remotes', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {
      remotes: {
        remote1: {
          name: 'remote1',
          entryGlobalName: 'Button',
          entry: 'https://cdn.example.com/remoteEntry.js',
          type: 'var',
        },
      },
      usedRemotes: { remote1: new Set(['remote1/Button']) },
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.remotes).toContainEqual({
      federationContainerName: 'Button',
      moduleName: 'Button',
      alias: 'remote1',
      entry: '*',
    });
  });

  it('points Nuxt dev ssrRemoteEntry at the SSR middleware path', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {}, 'serve', '/_nuxt/');

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.metaData.ssrRemoteEntry).toMatchObject({
      name: 'remoteEntry.ssr.js',
      path: '/__mf_ssr__/',
      type: 'module',
    });
  });

  it('uses a served remoteEntry filename for hash patterns in serve manifest', async () => {
    const emitted = await runGenerateBundleWithManifest(
      true,
      {
        filename: 'remoteEntry-[hash]',
        exposePaths: {
          './exposed': { import: './src/exposed.js' },
        },
        usedShares: new Set(['react']),
        shareItems: {
          react: {
            version: '18.0.0',
            shareConfig: { requiredVersion: '^18.0.0', singleton: true },
          },
        },
      },
      'serve'
    );

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.metaData.remoteEntry).toMatchObject({
      name: 'remoteEntry.js',
      type: 'module',
    });
    expect(manifest.metaData.ssrRemoteEntry).toMatchObject({
      name: 'remoteEntry.ssr.js',
      path: '/__mf_ssr__/',
      type: 'module',
    });
    expect(manifest.shared[0].assets.js.sync).toEqual(['remoteEntry.js']);
    expect(manifest.exposes[0].assets.js.sync).toEqual(['remoteEntry.js']);
  });

  it('serves hash-pattern dev remoteEntry through stable manifest filename', async () => {
    getNormalizeModuleFederationOptions.mockReturnValue({
      name: 'basicRemote',
      filename: 'remoteEntry-[hash]',
      getPublicPath: undefined,
      varFilename: undefined,
      manifest: true,
      exposes: { './exposed': { import: './src/exposed.js' } },
      remotes: {},
      shared: {},
      publicPath: 'auto',
      bundleAllCSS: false,
      shareStrategy: 'version-first',
      implementation: 'module-federation-runtime',
      runtimePlugins: [],
      virtualModuleDir: '__mf__virtual',
      hostInitInjectLocation: 'html',
      moduleParseTimeout: 10,
      ignoreOrigin: false,
    });
    getUsedRemotesMap.mockReturnValue(new Map());
    getUsedShares.mockReturnValue(new Set());

    const [servePlugin, buildPlugin] = manifestPlugin();
    const handlers: Function[] = [];

    callHook(buildPlugin.config, {} as ConfigPluginContext, {}, { command: 'serve', mode: 'test' });
    callHook(
      buildPlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        root: '/',
        base: '/',
        build: {},
        server: { origin: 'http://localhost' },
      } as unknown as ResolvedConfig
    );
    callHook(
      servePlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        base: '/',
      } as unknown as ResolvedConfig
    );
    callHook(
      servePlugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        middlewares: { use: (handler: Function) => handlers.push(handler) },
      } as any
    );

    const remoteEntryReq = { url: '/remoteEntry.js?cache=1' };
    const next = vi.fn();
    handlers[0](remoteEntryReq, {}, next);
    expect(remoteEntryReq.url).toBe('/remoteEntry-[hash]?cache=1');
    expect(next).toHaveBeenCalledOnce();

    const source = await new Promise<string>((resolve, reject) => {
      handlers[0](
        { url: '/mf-manifest.json' },
        {
          setHeader: vi.fn(),
          end: resolve,
        },
        reject
      );
    });
    const manifest = JSON.parse(source);

    expect(manifest.metaData.remoteEntry.name).toBe('remoteEntry.js');
    expect(manifest.metaData.ssrRemoteEntry.name).toBe('remoteEntry.ssr.js');
    expect(manifest.exposes[0].assets.js.sync).toEqual(['remoteEntry.js']);
  });

  it('serves hash-pattern dev remoteEntry through stable filename without manifest', () => {
    getNormalizeModuleFederationOptions.mockReturnValue({
      name: 'basicRemote',
      filename: 'remoteEntry-[hash]',
      getPublicPath: undefined,
      varFilename: undefined,
      manifest: undefined,
      exposes: { './exposed': { import: './src/exposed.js' } },
      remotes: {},
      shared: {},
      publicPath: 'auto',
      bundleAllCSS: false,
      shareStrategy: 'version-first',
      implementation: 'module-federation-runtime',
      runtimePlugins: [],
      virtualModuleDir: '__mf__virtual',
      hostInitInjectLocation: 'html',
      moduleParseTimeout: 10,
      ignoreOrigin: false,
    });

    const [servePlugin, buildPlugin] = manifestPlugin();
    const handlers: Function[] = [];

    callHook(buildPlugin.config, {} as ConfigPluginContext, {}, { command: 'serve', mode: 'test' });
    callHook(
      servePlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        base: '/',
      } as unknown as ResolvedConfig
    );
    callHook(
      servePlugin.configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        middlewares: { use: (handler: Function) => handlers.push(handler) },
      } as any
    );

    const remoteEntryReq = { url: '/remoteEntry.js?cache=1' };
    const next = vi.fn();
    handlers[0](remoteEntryReq, {}, next);

    expect(remoteEntryReq.url).toBe('/remoteEntry-[hash]?cache=1');
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps build manifest remoteEntry resolved from emitted bundle', async () => {
    const bundle = makeBundle();
    const remoteEntry = bundle['remoteEntry.js'] as OutputChunk;
    remoteEntry.fileName = 'remoteEntry-a1b2c3d4.js';
    const emitted = await runGenerateBundleWithManifest(true, {
      filename: 'remoteEntry-[hash]',
      bundle,
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.metaData.remoteEntry.name).toBe('remoteEntry-a1b2c3d4.js');
    expect(manifest.metaData.ssrRemoteEntry.name).toBe('remoteEntry-a1b2c3d4.ssr.js');
  });

  // An expose basenamed like the container gets the same chunk name; even emitted first,
  // the manifest must point at the container, not the expose. Covers a camelCase
  // `remoteEntry.js` and a kebab `remote-entry.js` filename.
  it.each(['remote-entry', 'remoteEntry'])(
    'resolves the build remoteEntry to the %s container, not a same-named expose',
    async (base) => {
      const filename = `${base}.js`;
      const exposeFile = `assets/${base}-abc123.js`;
      const container = {
        ...(makeBundle()['remoteEntry.js'] as OutputChunk),
        fileName: filename,
        name: base,
      };
      const bundle: OutputBundle = {
        [exposeFile]: { ...container, fileName: exposeFile, facadeModuleId: '/src/expose.js' },
        [filename]: container,
      };

      const emitted = await runGenerateBundleWithManifest(true, { bundle, filename });
      const manifest = JSON.parse(emitted['mf-manifest.json']);

      expect(manifest.metaData.remoteEntry.name).toBe(filename);
    }
  );

  it('emits companion stats file using manifest fileName suffix', async () => {
    const emitted = await runGenerateBundleWithManifest({
      fileName: 'path/custom-manifest.json',
    });

    const manifest = emitted['path/custom-manifest.json'];
    const stats = emitted['path/custom-manifest-stats.json'];

    expect(manifest).toBeDefined();
    expect(stats).toBeDefined();
  });

  it('applies manifest additionalData mutations to manifest and stats', async () => {
    const emitted = await runGenerateBundleWithManifest({
      additionalData: ({ stats }: { stats: Record<string, any> }) => {
        stats.metaData.ssrRemoteEntry = stats.metaData.remoteEntry;
      },
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    const stats = JSON.parse(emitted['mf-stats.json']);

    expect(manifest.metaData.ssrRemoteEntry).toEqual(manifest.metaData.remoteEntry);
    expect(stats.metaData.ssrRemoteEntry).toEqual(stats.metaData.remoteEntry);
  });

  it('uses manifest additionalData return value', async () => {
    const emitted = await runGenerateBundleWithManifest({
      additionalData: ({ stats }: { stats: Record<string, any> }) => ({
        ...stats,
        custom: true,
      }),
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    const stats = JSON.parse(emitted['mf-stats.json']);

    expect(manifest.custom).toBe(true);
    expect(stats.custom).toBe(true);
  });

  it('defaults disableAssetsAnalyze to true in serve when project is consumer-only', async () => {
    const emitted = await runGenerateBundleWithManifest(
      {},
      {
        usedShares: new Set(['react']),
        usedRemotes: new Map([['remote-app', new Set(['remote-app/Button'])]]),
      },
      'serve'
    );

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    const stats = JSON.parse(emitted['mf-stats.json']);

    expect(manifest).not.toHaveProperty('shared');
    expect(manifest).not.toHaveProperty('exposes');
    expect(stats).not.toHaveProperty('assetAnalysis');
  });

  it('respects explicit disableAssetsAnalyze false in serve even for consumer-only', async () => {
    const emitted = await runGenerateBundleWithManifest(
      {
        disableAssetsAnalyze: false,
      },
      {
        usedShares: new Set(['react']),
        usedRemotes: new Map([['remote-app', new Set(['remote-app/Button'])]]),
      },
      'serve'
    );

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    const stats = JSON.parse(emitted['mf-stats.json']);

    expect(manifest).toHaveProperty('shared');
    expect(manifest).toHaveProperty('exposes');
    expect(stats).toHaveProperty('assetAnalysis');
  });

  it('omits shared/exposes from manifest and stats when disableAssetsAnalyze is true', async () => {
    const emitted = await runGenerateBundleWithManifest(
      {
        fileName: 'disabled-manifest.json',
        disableAssetsAnalyze: true,
      },
      {
        exposePaths: {
          './exposed': { import: './src/exposed.js' },
        },
        usedShares: new Set(['react']),
        usedRemotes: new Map([['remote-app', new Set(['remote-app/Button'])]]),
      }
    );

    const manifest = JSON.parse(emitted['disabled-manifest.json']);
    const stats = JSON.parse(emitted['disabled-manifest-stats.json']);

    expect(manifest).not.toHaveProperty('shared');
    expect(manifest).not.toHaveProperty('exposes');
    expect(stats).not.toHaveProperty('assetAnalysis');
  });

  it('skips used shared keys missing from normalized shared config', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {
      usedShares: new Set(['react', '@scope/utils']),
      shareItems: {
        react: {
          version: '18.0.0',
          shareConfig: { requiredVersion: '^18.0.0', singleton: true },
        },
        '@scope/utils': undefined,
      },
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);

    expect(manifest.shared).toHaveLength(1);
    expect(manifest.shared[0]).toMatchObject({
      name: 'react',
      version: '18.0.0',
      singleton: true,
      requiredVersion: '^18.0.0',
    });
  });

  it('uses auto publicPath when Vite base was not explicitly configured', async () => {
    const emitted = await runGenerateBundleWithManifest(true);

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.publicPath).toBe('auto');
  });

  it('uses configured Vite base as publicPath', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {}, 'build', '/remote/');

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.publicPath).toBe('/remote/');
  });

  it('advertises the types archive url when type generation is enabled', async () => {
    const emitted = await runGenerateBundleWithManifest(true, { dts: { generateTypes: true } });

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.types).toMatchObject({
      zip: '@mf-types.zip',
      api: '@mf-types.d.ts',
    });
  });

  it('honors a custom generateTypes.typesFolder in the advertised url', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {
      dts: { generateTypes: { typesFolder: '@types' } },
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.types).toMatchObject({
      zip: '@types.zip',
      api: '@types.d.ts',
    });
  });

  it('omits the types archive url when dts is disabled', async () => {
    const emitted = await runGenerateBundleWithManifest(true, { dts: false });

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.types).toEqual({ path: '', name: '' });
    expect(manifest.metaData.types.zip).toBeUndefined();
  });

  it('omits the types archive url when generateTypes is disabled', async () => {
    const emitted = await runGenerateBundleWithManifest(true, {
      dts: { generateTypes: false },
    });

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.types).toEqual({ path: '', name: '' });
  });

  it('preserves publicPath "auto" in manifest metaData', async () => {
    getNormalizeModuleFederationOptions.mockReturnValue({
      name: 'basicRemote',
      filename: 'remoteEntry.js',
      getPublicPath: undefined,
      varFilename: undefined,
      manifest: true,
      exposes: {},
      remotes: {},
      shared: {},
      publicPath: 'auto',
      bundleAllCSS: false,
      shareStrategy: 'version-first',
      implementation: 'module-federation-runtime',
      runtimePlugins: [],
      virtualModuleDir: '__mf__virtual',
      hostInitInjectLocation: 'html',
      moduleParseTimeout: 10,
      ignoreOrigin: false,
    });
    getUsedRemotesMap.mockReturnValue(new Map());
    getUsedShares.mockReturnValue(new Set());

    const [, buildPlugin] = manifestPlugin();
    const emitted: Record<string, string> = {};

    callHook(buildPlugin.config, {} as ConfigPluginContext, {}, { command: 'build', mode: 'test' });
    callHook(
      buildPlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        root: '/',
        base: '/',
        build: {},
        server: { origin: 'http://localhost' },
      } as unknown as ResolvedConfig
    );

    const emitFile: EmitFile = (asset) => {
      if ('fileName' in asset && typeof asset.fileName === 'string' && 'source' in asset) {
        emitted[asset.fileName] =
          typeof asset.source === 'string'
            ? asset.source
            : Buffer.from(asset.source ?? new Uint8Array()).toString('utf8');
        return `id:${asset.fileName}`;
      }
      return 'id:unknown';
    };
    const ctx: TestPluginContext = {
      emitFile,
      resolve: async (source) =>
        ({
          id: `/node_modules/${source}/index.js`,
          external: false,
        }) as ResolvedId,
    };

    await runGenerateBundle(buildPlugin, ctx, makeBundle());

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.publicPath).toBe('auto');
  });
});
