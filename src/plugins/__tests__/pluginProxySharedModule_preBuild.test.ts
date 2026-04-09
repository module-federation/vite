import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasPackageDependencyMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn(),
}));

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: hasPackageDependencyMock,
  setPackageDetectionCwd: vi.fn(),
  getPackageDetectionCwd: vi.fn(() => '/repo/apps/remote'),
  getIsRolldown: () => false,
  removePathFromNpmPackage: (value: string) =>
    value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0],
}));

vi.mock('../../utils/VirtualModule', () => ({
  default: class MockVirtualModule {
    getPath() {
      return '/mock/path.js';
    }
    getImportId() {
      return 'mock-import-id';
    }
    writeSync() {}
  },
  assertModuleFound: (_tag: string, value: string) => ({
    name: value.startsWith('transitive-no-override')
      ? 'transitive-no-override'
      : value.startsWith('transitive') || value.startsWith('transitive/')
        ? 'transitive'
        : value,
  }),
}));

import { proxySharedModule } from '../pluginProxySharedModule_preBuild';
import { NormalizedShared } from '../../utils/normalizeModuleFederationOptions';

const preBuildShareItemMap = new Map<string, NormalizedShared[string]>();
const addUsedSharesCalls: string[] = [];

vi.mock('../../virtualModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../virtualModules')>();
  return {
    ...actual,
    writePreBuildLibPath: (pkg: string, shareItem?: NormalizedShared[string]) => {
      preBuildShareItemMap.set(pkg, shareItem);
    },
    addUsedShares: (pkg: string) => {
      addUsedSharesCalls.push(pkg);
    },
    writeLocalSharedImportMap: vi.fn(),
    getPreBuildShareItem: (pkg: string) => preBuildShareItemMap.get(pkg),
    getConcreteSharedImportSource: (pkg: string, shareItem?: NormalizedShared[string]) =>
      typeof shareItem?.shareConfig.import === 'string'
        ? shareItem.shareConfig.import
        : pkg === 'transitive-no-override'
          ? '/workspace/packages/transitive-no-override/dist/index.js'
          : undefined,
  };
});

function makeShared(): NormalizedShared {
  return {
    react: {
      name: 'react',
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^19.2.4',
        strictVersion: false,
      },
    },
    vue: {
      name: 'vue',
      from: '',
      version: '3.4.0',
      scope: 'default',
      shareConfig: {
        singleton: false,
        requiredVersion: '^3.4.0',
        strictVersion: false,
      },
    },
    transitive: {
      name: 'transitive',
      from: '',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        import: '/abs/transitive/index.js',
        singleton: false,
        requiredVersion: '^1.0.0',
        strictVersion: false,
      },
    },
    'transitive-no-override': {
      name: 'transitive-no-override',
      from: '',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: false,
        requiredVersion: '^1.0.0',
        strictVersion: false,
      },
    },
  };
}

describe('pluginProxySharedModule_preBuild', () => {
  beforeEach(() => {
    hasPackageDependencyMock.mockReset();
    preBuildShareItemMap.clear();
    addUsedSharesCalls.length = 0;
  });

  for (const testCase of [
    {
      name: 'does not proxy react through loadShare in serve mode when vinext is enabled',
      source: 'react',
      hasVinext: true,
      hasAstro: false,
      aliasExpected: false,
      shouldProxy: false,
    },
    {
      name: 'does not proxy react through loadShare in serve mode when astro is enabled',
      source: 'react',
      hasVinext: false,
      hasAstro: true,
      aliasExpected: false,
      shouldProxy: false,
    },
    {
      name: 'proxies react through loadShare in serve mode when vinext is disabled',
      source: 'react',
      hasVinext: false,
      hasAstro: false,
      aliasExpected: true,
      shouldProxy: true,
    },
    {
      name: 'proxies non-react shared modules through loadShare in serve mode when vinext is enabled',
      source: 'vue',
      hasVinext: true,
      hasAstro: false,
      aliasExpected: true,
      shouldProxy: true,
    },
    {
      name: 'proxies non-react shared modules through loadShare in serve mode when vinext is disabled',
      source: 'vue',
      hasVinext: false,
      hasAstro: false,
      aliasExpected: true,
      shouldProxy: true,
    },
  ]) {
    it(testCase.name, async () => {
      hasPackageDependencyMock.mockImplementation((pkg: string) => {
        if (pkg === 'vinext') return testCase.hasVinext;
        if (pkg === 'astro') return testCase.hasAstro;
        return false;
      });

      const plugins = proxySharedModule({ shared: makeShared() });
      const proxyPlugin = plugins[1];
      const config = {
        resolve: {
          alias: [] as Array<{
            find: RegExp;
            customResolver?: (source: string, importer: string) => unknown;
          }>,
        },
      };

      proxyPlugin.config?.call(
        {
          meta: {},
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        },
        config as any,
        {
          command: 'serve',
          mode: 'development',
        }
      );

      const alias = config.resolve.alias.find((entry) => entry.find.test(testCase.source));
      if (!testCase.aliasExpected) {
        expect(alias).toBeUndefined();
        return;
      }

      expect(alias).toBeDefined();

      if (testCase.shouldProxy) {
        expect(alias?.customResolver).toBeTypeOf('function');
        return;
      }

      const resolution = await alias?.customResolver?.call(
        {
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        },
        testCase.source,
        '/src/main.ts'
      );
      expect(resolution).toBeUndefined();
    });
  }

  it('skips prebuild for import: false shared deps in configResolved', () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const shared: NormalizedShared = {
      ...makeShared(),
      'host-only': {
        name: 'host-only',
        from: '',
        version: undefined,
        scope: 'default',
        shareConfig: {
          import: false,
          singleton: true,
          requiredVersion: '*',
          strictVersion: false,
        },
      },
    };

    const plugins = proxySharedModule({ shared });
    const proxyPlugin = plugins[1];
    const config = {
      resolve: { alias: [] as any[] },
    };

    proxyPlugin.config?.call(
      { meta: {}, resolve: async (id: string) => ({ id: `/resolved/${id}` }) },
      config as any,
      { command: 'serve', mode: 'development' }
    );
    proxyPlugin.configResolved?.({
      cacheDir: '/vite/deps',
      experimental: { rolldownDev: false },
    } as any);

    // import: false dep should not have a prebuild entry
    expect(preBuildShareItemMap.has('host-only')).toBe(false);
    // Normal deps should still have prebuild entries
    expect(preBuildShareItemMap.has('react')).toBe(true);
    expect(preBuildShareItemMap.has('vue')).toBe(true);
  });

  it('proxies package subpath imports through the base shared config', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const shared = makeShared();
    const plugins = proxySharedModule({ shared });
    const proxyPlugin = plugins[1];
    const config = {
      resolve: {
        alias: [] as Array<{
          find: RegExp;
          customResolver?: (source: string, importer: string) => unknown;
        }>,
      },
    };

    proxyPlugin.config?.call(
      {
        meta: {},
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      },
      config as any,
      {
        command: 'serve',
        mode: 'development',
      }
    );

    const alias = config.resolve.alias.find((entry) => entry.find.test('transitive/runtime.js'));
    expect(alias?.customResolver).toBeTypeOf('function');

    const resolution = await alias?.customResolver?.call(
      {
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      },
      'transitive/runtime.js',
      '/src/main.ts'
    );

    expect(resolution).toEqual({ id: '/resolved//mock/path.js' });
    expect(preBuildShareItemMap.get('transitive/runtime.js')).toBe(shared.transitive);
    expect(addUsedSharesCalls).toContain('transitive/runtime.js');
  });

  it('resolves prebuild aliases to configured share import sources in build mode', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = plugins[1];
    const config = {
      resolve: {
        alias: [] as Array<{
          find: RegExp;
          replacement?: string | ((value: string) => string);
        }>,
      },
    };

    proxyPlugin.config?.call({ meta: {} }, config as any, {
      command: 'build',
      mode: 'production',
    });

    preBuildShareItemMap.set('transitive', makeShared().transitive);

    const alias = config.resolve.alias.find((entry) => entry.find.test('x__prebuild__x'));
    expect(alias).toBeDefined();
    expect(typeof alias?.replacement).toBe('function');
    expect((alias?.replacement as (value: string) => string)('transitive__prebuild__')).toBe(
      '/abs/transitive/index.js'
    );
  });

  it('resolves prebuild aliases from the original shared key, not just pkg name', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const shared = makeShared();
    shared['transitive/'] = {
      ...shared.transitive,
      shareConfig: {
        ...shared.transitive.shareConfig,
        import: '/abs/transitive/slash-entry.js',
      },
    };
    delete shared.transitive;

    const plugins = proxySharedModule({ shared });
    const proxyPlugin = plugins[1];
    const config = {
      resolve: {
        alias: [] as Array<{
          find: RegExp;
          customResolver?: (source: string, importer: string) => unknown;
          replacement?: string | ((value: string) => string);
        }>,
      },
    };

    proxyPlugin.config?.call(
      {
        meta: {},
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      },
      config as any,
      {
        command: 'build',
        mode: 'production',
      }
    );

    preBuildShareItemMap.set('transitive', shared['transitive/']);

    const prebuildAlias = config.resolve.alias.find((entry) => entry.find.test('x__prebuild__x'));
    expect(prebuildAlias).toBeDefined();
    expect(typeof prebuildAlias?.replacement).toBe('function');
    expect(
      (prebuildAlias?.replacement as (value: string) => string)('transitive__prebuild__')
    ).toBe('/abs/transitive/slash-entry.js');
  });

  it('resolves prebuild aliases to auto-detected workspace sources without explicit share.import', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = plugins[1];
    const config = {
      resolve: {
        alias: [] as Array<{
          find: RegExp;
          replacement?: string | ((value: string) => string);
        }>,
      },
    };

    proxyPlugin.config?.call({ meta: {} }, config as any, {
      command: 'build',
      mode: 'production',
    });

    preBuildShareItemMap.set('transitive-no-override', makeShared()['transitive-no-override']);

    const alias = config.resolve.alias.find((entry) => entry.find.test('x__prebuild__x'));
    expect(alias).toBeDefined();
    expect(typeof alias?.replacement).toBe('function');
    expect(
      (alias?.replacement as (value: string) => string)('transitive-no-override__prebuild__')
    ).toBe('/workspace/packages/transitive-no-override/dist/index.js');
  });

  it('uses auto-detected workspace sources in serve prebuild resolution without null deref', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = plugins[1];
    const config = {
      resolve: {
        alias: [] as Array<{
          find: RegExp;
          customResolver?: (source: string, importer: string) => unknown;
        }>,
      },
    };

    proxyPlugin.config?.call(
      {
        meta: {},
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      },
      config as any,
      {
        command: 'serve',
        mode: 'development',
      }
    );
    proxyPlugin.configResolved?.({
      cacheDir: '/vite/deps',
      experimental: { rolldownDev: false },
    } as any);

    preBuildShareItemMap.set('transitive-no-override', makeShared()['transitive-no-override']);

    const alias = config.resolve.alias.find(
      (entry) => entry.customResolver && entry.find.test('x__prebuild__x')
    );
    expect(alias?.customResolver).toBeTypeOf('function');

    const resolution = await alias?.customResolver?.call(
      {
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      },
      'transitive-no-override__prebuild__',
      '/src/main.ts'
    );

    expect(resolution).toEqual({
      id: '/resolved//resolved//workspace/packages/transitive-no-override/dist/index.js',
    });
  });
});
