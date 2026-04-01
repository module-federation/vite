import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const makeBundle = () => ({
  'remoteEntry.js': {
    type: 'chunk',
    fileName: 'remoteEntry.js',
    code: 'const a = 1;',
    modules: {
      '/src/exposed.js': {},
    },
  },
  'styles.css': {
    type: 'asset',
    fileName: 'styles.css',
    source: 'body {}',
  },
});

async function runGenerateBundleWithManifest(
  manifestOptions: unknown,
  runtime: {
    usedShares?: Set<string>;
    usedRemotes?: Map<string, Set<string>>;
    exposePaths?: Record<string, { import: string }>;
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
  } as any);
  getUsedRemotesMap.mockReturnValue(runtime.usedRemotes || new Map());
  getUsedShares.mockReturnValue(runtime.usedShares || new Set());
  getNormalizeShareItem.mockReturnValue({
    version: '1.0.0',
    shareConfig: { requiredVersion: '*' },
  });

  const [, buildPlugin] = manifestPlugin();
  const emitted: Record<string, string> = {};

  buildPlugin.config?.({}, { command, mode: 'test' });
  buildPlugin.configResolved?.({
    root: '/',
    base: '/',
    build: {},
    server: { origin: 'http://localhost' },
  } as any);

  const ctx = {
    emitFile: vi.fn((asset: { fileName: string; source: string }) => {
      emitted[asset.fileName] = asset.source;
      return `id:${asset.fileName}`;
    }),
    resolve: vi.fn(async () => ({ id: '/node_modules/react/index.js' })),
  };

  await buildPlugin.generateBundle?.call(ctx as any, {}, makeBundle() as any);
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
      stats.buildOutput.find((chunk: any) => chunk.fileName === 'remoteEntry.js')
    ).toBeTruthy();
  });

  it('emits companion stats file using manifest fileName suffix', async () => {
    const emitted = await runGenerateBundleWithManifest({
      fileName: 'path/custom-manifest.json',
    } as any);

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
      } as any,
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
      } as any,
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
    } as any);
    getUsedRemotesMap.mockReturnValue(new Map());
    getUsedShares.mockReturnValue(new Set());

    const [, buildPlugin] = manifestPlugin();
    const emitted: Record<string, string> = {};

    buildPlugin.config?.({}, { command: 'build', mode: 'test' });
    buildPlugin.configResolved?.({
      root: '/',
      base: '/',
      build: {},
      server: { origin: 'http://localhost' },
    } as any);

    const ctx = {
      emitFile: vi.fn((asset: { fileName: string; source: string }) => {
        emitted[asset.fileName] = asset.source;
        return `id:${asset.fileName}`;
      }),
      resolve: vi.fn(async () => ({ id: '/node_modules/react/index.js' })),
    };

    await buildPlugin.generateBundle?.call(ctx as any, {}, makeBundle() as any);

    const manifest = JSON.parse(emitted['mf-manifest.json']);
    expect(manifest.metaData.publicPath).toBe('auto');
  });
});
