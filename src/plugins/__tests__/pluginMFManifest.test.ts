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
    usedRemotes?: Map<string, Set<string>>;
    exposePaths?: Record<string, { import: string }>;
    shareItems?: Record<
      string,
      | {
          version: string;
          shareConfig: { requiredVersion: string; singleton?: boolean };
        }
      | undefined
    >;
  } = {},
  command: 'serve' | 'build' = 'build'
): Promise<Record<string, string>> {
  getNormalizeModuleFederationOptions.mockReturnValue({
    name: 'basicRemote',
    filename: 'remoteEntry.js',
    getPublicPath: undefined,
    varFilename: undefined,
    manifest: manifestOptions,
    exposes: runtime.exposePaths || {},
    remotes: {},
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

  callHook(buildPlugin.config, {} as ConfigPluginContext, {}, { command, mode: 'test' });
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
  return emitted;
}

describe('pluginMFManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('emits companion stats file using manifest fileName suffix', async () => {
    const emitted = await runGenerateBundleWithManifest({
      fileName: 'path/custom-manifest.json',
    });

    const manifest = emitted['path/custom-manifest.json'];
    const stats = emitted['path/custom-manifest-stats.json'];

    expect(manifest).toBeDefined();
    expect(stats).toBeDefined();
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
