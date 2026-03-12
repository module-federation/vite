import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedShared } from '../../utils/normalizeModuleFederationOptions';
import { proxySharedModule } from '../pluginProxySharedModule_preBuild';

const {
  addUsedSharesSpy,
  getLoadShareModulePathSpy,
  writeLoadShareModuleSpy,
  writeLocalSharedImportMapSpy,
  writePreBuildLibPathSpy,
} = vi.hoisted(() => ({
  addUsedSharesSpy: vi.fn(),
  getLoadShareModulePathSpy: vi.fn(() => '/virtual/loadShare.js'),
  writeLoadShareModuleSpy: vi.fn(),
  writeLocalSharedImportMapSpy: vi.fn(),
  writePreBuildLibPathSpy: vi.fn(),
}));

vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: () => {
      const loader = ((pkg: string) => (pkg === 'workspace-pkg' ? {} : {})) as ((
        pkg: string
      ) => any) & { resolve: (pkg: string) => string };

      loader.resolve = (pkg: string) => {
        if (pkg === 'workspace-pkg') {
          return '/workspace/packages/workspace-pkg/src/index.ts';
        }
        if (pkg === 'third-party-pkg') {
          return '/workspace/node_modules/third-party-pkg/index.js';
        }
        throw new Error(`Cannot resolve ${pkg}`);
      };

      return loader;
    },
  };
});

vi.mock('../../virtualModules', () => {
  return {
    PREBUILD_TAG: '__prebuild__',
    addUsedShares: addUsedSharesSpy,
    generateLocalSharedImportMap: vi.fn(() => 'export {}'),
    getLoadShareModulePath: getLoadShareModulePathSpy,
    getLocalSharedImportMapPath: vi.fn(() => '/virtual/localSharedImportMap.js'),
    writeLoadShareModule: writeLoadShareModuleSpy,
    writeLocalSharedImportMap: writeLocalSharedImportMapSpy,
    writePreBuildLibPath: writePreBuildLibPathSpy,
  };
});

vi.mock('../pluginModuleParseEnd', () => ({
  parsePromise: Promise.resolve(),
}));

describe('proxySharedModule', () => {
  const shared = {
    'react-dom': {
      name: 'react-dom',
      version: '19.0.0',
      scope: 'default',
      from: '',
      shareConfig: {},
    },
    'react-dom/': {
      name: 'react-dom/',
      version: '19.0.0',
      scope: 'default',
      from: '',
      shareConfig: {},
    },
    'react-dom/client': {
      name: 'react-dom/client',
      version: '19.0.0',
      scope: 'default',
      from: '',
      shareConfig: {},
    },
    'workspace-pkg': {
      name: 'workspace-pkg',
      version: '1.0.0',
      scope: 'default',
      from: '',
      shareConfig: {},
    },
  } satisfies NormalizedShared;

  beforeEach(() => {
    addUsedSharesSpy.mockClear();
    getLoadShareModulePathSpy.mockClear();
    writeLoadShareModuleSpy.mockClear();
    writeLocalSharedImportMapSpy.mockClear();
    writePreBuildLibPathSpy.mockClear();
  });

  it('skips react-dom shares during serve', () => {
    const plugin = proxySharedModule({ shared })[1];
    const config = { resolve: { alias: [] as any[] } };

    plugin.config!.call({ meta: {} }, config as any, { command: 'serve' } as any);
    plugin.configResolved!({ experimental: {}, cacheDir: '/.vite' } as any);

    expect(config.resolve.alias).toHaveLength(2);
    const workspaceShareAlias = config.resolve.alias.find(
      (entry) =>
        entry.customResolver && entry.find instanceof RegExp && entry.find.test('workspace-pkg')
    );
    expect(workspaceShareAlias).toBeDefined();
    expect(writeLoadShareModuleSpy).toHaveBeenCalledTimes(1);
    expect(writeLoadShareModuleSpy).toHaveBeenCalledWith(
      'workspace-pkg',
      shared['workspace-pkg'],
      'serve',
      false
    );
    expect(writePreBuildLibPathSpy).toHaveBeenCalledTimes(1);
    expect(writePreBuildLibPathSpy).toHaveBeenCalledWith('workspace-pkg');
    expect(addUsedSharesSpy).toHaveBeenCalledTimes(1);
    expect(addUsedSharesSpy).toHaveBeenCalledWith('workspace-pkg');
  });

  it('keeps local workspace shared imports local during build', async () => {
    const plugin = proxySharedModule({ shared })[1];
    const config = { resolve: { alias: [] as any[] } };

    plugin.config!.call({ meta: {} }, config as any, { command: 'build' } as any);

    const sharedAlias = config.resolve.alias.find(
      (entry) =>
        entry.customResolver && entry.find instanceof RegExp && entry.find.test('workspace-pkg')
    );
    expect(sharedAlias).toBeDefined();

    const resolveSpy = vi.fn();
    const result = await sharedAlias.customResolver.call(
      { resolve: resolveSpy },
      'workspace-pkg',
      '/workspace/apps/host/src/App.tsx'
    );

    expect(result).toBeUndefined();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(getLoadShareModulePathSpy).not.toHaveBeenCalled();
    expect(writeLoadShareModuleSpy).not.toHaveBeenCalled();
    expect(writePreBuildLibPathSpy).not.toHaveBeenCalled();
    expect(addUsedSharesSpy).not.toHaveBeenCalled();
  });
});
