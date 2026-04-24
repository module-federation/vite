import type {
  ConfigEnv,
  ConfigPluginContext,
  MinimalPluginContextWithoutEnvironment,
  ResolvedConfig,
  UserConfig,
} from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

const { hasPackageDependencyMock, existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn<(pkg: string) => boolean>(),
  existsSyncMock: vi.fn<(path: string) => boolean>(() => false),
  readFileSyncMock: vi.fn<(path: string) => string>(() => '{}'),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: hasPackageDependencyMock,
  getInstalledPackageEntry: vi.fn(() => undefined),
  getInstalledPackageJson: vi.fn((pkg: string) => {
    const match = pkg.match(/^(?:@[^/]+\/)?[^/]+/);
    const packageName = match ? match[0] : pkg;
    const packageJsonPath = `/repo/apps/remote/node_modules/${packageName}/package.json`;
    if (!existsSyncMock(packageJsonPath)) return undefined;
    return {
      path: packageJsonPath,
      dir: `/repo/apps/remote/node_modules/${packageName}`,
      packageJson: JSON.parse(readFileSyncMock(packageJsonPath)),
    };
  }),
  setPackageDetectionCwd: vi.fn(),
  getPackageDetectionCwd: vi.fn(() => '/repo/apps/remote'),
  getIsRolldown: () => false,
  getPackageName: (pkg: string) => {
    const match = pkg.match(/^(?:@[^/]+\/)?[^/]+/);
    return match ? match[0] : pkg;
  },
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
        : value.startsWith('react')
          ? 'react'
          : value,
  }),
}));

import { proxySharedModule } from '../pluginProxySharedModule_preBuild';
import { NormalizedShared } from '../../utils/normalizeModuleFederationOptions';

type AliasEntry = {
  find: RegExp;
  replacement?: string | ((value: string) => string);
};

type MockUserConfig = UserConfig & {
  resolve: {
    alias: AliasEntry[];
  };
};

const preBuildShareItemMap = new Map<string, NormalizedShared[string] | undefined>();
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

function getProxyPlugin(plugins: ReturnType<typeof proxySharedModule>) {
  return plugins[1];
}

function getSharedResolvePlugin(plugins: ReturnType<typeof proxySharedModule>) {
  return plugins[2];
}

function getPrebuildResolvePlugin(plugins: ReturnType<typeof proxySharedModule>) {
  return plugins[3];
}

type TestPluginMeta = {
  rollupVersion: string;
  rolldownVersion: string;
  viteVersion: string;
  watchMode: boolean;
};

function createPluginMeta(overrides: Partial<TestPluginMeta> = {}): TestPluginMeta {
  return {
    rollupVersion: '4.0.0',
    rolldownVersion: '1.0.0',
    viteVersion: '7.0.0',
    watchMode: false,
    ...overrides,
  };
}

vi.mock('../../virtualModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../virtualModules')>();
  return {
    ...actual,
    writePreBuildLibPath: (pkg: string, shareItem?: NormalizedShared[string]) => {
      preBuildShareItemMap.set(pkg, shareItem);
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
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
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
      const proxyPlugin = getProxyPlugin(plugins);
      const sharedResolvePlugin = getSharedResolvePlugin(plugins);
      const config: MockUserConfig = {
        resolve: {
          alias: [],
        },
      };

      callHook(
        proxyPlugin.config,
        {
          meta: createPluginMeta(),
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        } as unknown as ConfigPluginContext,
        config,
        {
          command: 'serve',
          mode: 'development',
        } as ConfigEnv
      );

      if (!testCase.aliasExpected) {
        const resolution = await callHook(
          sharedResolvePlugin.resolveId,
          {
            resolve: async (id: string) => ({ id: `/resolved/${id}` }),
          } as any,
          testCase.source,
          '/src/main.ts',
          { isEntry: false }
        );
        expect(resolution).toBeUndefined();
        return;
      }

      if (testCase.shouldProxy) {
        const resolution = await callHook(
          sharedResolvePlugin.resolveId,
          {
            resolve: async (id: string) => ({ id: `/resolved/${id}` }),
          } as any,
          testCase.source,
          '/src/main.ts',
          { isEntry: false }
        );
        expect((resolution as { id: string }).id).toBeDefined();
        return;
      }

      const resolution = await callHook(
        sharedResolvePlugin.resolveId,
        {
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        } as any,
        testCase.source,
        '/src/main.ts',
        { isEntry: false }
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
    const proxyPlugin = getProxyPlugin(plugins);
    const config: MockUserConfig = {
      resolve: { alias: [] },
    };

    callHook(
      proxyPlugin.config,
      {
        meta: createPluginMeta(),
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      } as unknown as ConfigPluginContext,
      config,
      { command: 'serve', mode: 'development' } as ConfigEnv
    );
    callHook(
      proxyPlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        cacheDir: '/vite/deps',
        experimental: { rolldownDev: false },
      } as unknown as ResolvedConfig
    );

    // import: false dep should not have a prebuild entry
    expect(preBuildShareItemMap.has('host-only')).toBe(false);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Shared dependency "host-only" has import: false')
    );
    // Normal deps should still have prebuild entries
    expect(preBuildShareItemMap.has('react')).toBe(true);
    expect(preBuildShareItemMap.has('vue')).toBe(true);
  });

  it('resolves prebuild aliases to configured share import sources in build mode', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = getProxyPlugin(plugins);
    const prebuildResolvePlugin = getPrebuildResolvePlugin(plugins);
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    callHook(
      proxyPlugin.config,
      { meta: createPluginMeta() } as unknown as ConfigPluginContext,
      config,
      {
        command: 'build',
        mode: 'production',
      } as ConfigEnv
    );

    preBuildShareItemMap.set('transitive', makeShared().transitive);

    const resolution = await callHook(
      prebuildResolvePlugin.resolveId,
      {
        resolve: async (id: string) => ({ id }),
      } as any,
      'transitive__prebuild__',
      '/src/main.ts',
      { isEntry: false }
    );
    expect((resolution as { id: string }).id).toBe('/abs/transitive/index.js');
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
    const proxyPlugin = getProxyPlugin(plugins);
    const prebuildResolvePlugin = getPrebuildResolvePlugin(plugins);
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    callHook(
      proxyPlugin.config,
      {
        meta: createPluginMeta(),
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      } as unknown as ConfigPluginContext,
      config,
      {
        command: 'build',
        mode: 'production',
      } as ConfigEnv
    );

    preBuildShareItemMap.set('transitive', shared['transitive/']);

    const resolution = await callHook(
      prebuildResolvePlugin.resolveId,
      {
        resolve: async (id: string) => ({ id }),
      } as any,
      'transitive__prebuild__',
      '/src/main.ts',
      { isEntry: false }
    );
    expect((resolution as { id: string }).id).toBe('/abs/transitive/slash-entry.js');
  });

  it('resolves prebuild aliases to auto-detected workspace sources without explicit share.import', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = getProxyPlugin(plugins);
    const prebuildResolvePlugin = getPrebuildResolvePlugin(plugins);
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    callHook(
      proxyPlugin.config,
      { meta: createPluginMeta() } as unknown as ConfigPluginContext,
      config,
      {
        command: 'build',
        mode: 'production',
      } as ConfigEnv
    );

    preBuildShareItemMap.set('transitive-no-override', makeShared()['transitive-no-override']);

    const resolution = await callHook(
      prebuildResolvePlugin.resolveId,
      {
        resolve: async (id: string) => ({ id }),
      } as any,
      'transitive-no-override__prebuild__',
      '/src/main.ts',
      { isEntry: false }
    );
    expect((resolution as { id: string }).id).toBe(
      '/workspace/packages/transitive-no-override/dist/index.js'
    );
  });

  it('does not proxy shared deps imported from build config files', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = getProxyPlugin(plugins);
    const sharedResolvePlugin = getSharedResolvePlugin(plugins);
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    callHook(
      proxyPlugin.config,
      {
        meta: createPluginMeta(),
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      } as unknown as ConfigPluginContext,
      config,
      {
        command: 'serve',
        mode: 'development',
      } as ConfigEnv
    );

    expect(
      await callHook(
        sharedResolvePlugin.resolveId,
        {
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        } as any,
        'vue',
        '/repo/nuxt.config.ts',
        { isEntry: false }
      )
    ).toBeUndefined();
  });

  it('excludes shared sub-dependencies in dev mode and warns', () => {
    hasPackageDependencyMock.mockReturnValue(false);

    // Simulate "lit" having lit-html, lit-element, @lit/reactive-element as dependencies
    existsSyncMock.mockImplementation(
      (p: string) => p === '/repo/apps/remote/node_modules/lit/package.json'
    );
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === '/repo/apps/remote/node_modules/lit/package.json') {
        return JSON.stringify({
          name: 'lit',
          dependencies: {
            'lit-html': '^3.0.0',
            'lit-element': '^4.0.0',
            '@lit/reactive-element': '^2.0.0',
          },
        });
      }
      return '{}';
    });

    const shared: NormalizedShared = {
      lit: {
        name: 'lit',
        from: '',
        version: '3.3.2',
        scope: 'default',
        shareConfig: { singleton: true, requiredVersion: '^3.3.2', strictVersion: false },
      },
      'lit-html': {
        name: 'lit-html',
        from: '',
        version: '3.3.2',
        scope: 'default',
        shareConfig: { singleton: true, requiredVersion: '^3.3.2', strictVersion: false },
      },
      'lit-element': {
        name: 'lit-element',
        from: '',
        version: '4.2.2',
        scope: 'default',
        shareConfig: { singleton: true, requiredVersion: '^4.2.2', strictVersion: false },
      },
      '@lit/reactive-element': {
        name: '@lit/reactive-element',
        from: '',
        version: '2.1.0',
        scope: 'default',
        shareConfig: { singleton: true, requiredVersion: '^2.1.0', strictVersion: false },
      },
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plugins = proxySharedModule({ shared });
    const proxyPlugin = getProxyPlugin(plugins);
    const config: MockUserConfig = { resolve: { alias: [] } };

    callHook(
      proxyPlugin.config,
      { meta: createPluginMeta() } as unknown as ConfigPluginContext,
      config,
      {
        command: 'serve',
        mode: 'development',
      } as ConfigEnv
    );

    // Sub-dependencies should be removed from shared
    expect(shared).toHaveProperty('lit');
    expect(shared).not.toHaveProperty('lit-html');
    expect(shared).not.toHaveProperty('lit-element');
    expect(shared).not.toHaveProperty('@lit/reactive-element');

    // Warnings should have been emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"lit-html" is a dependency of shared package "lit"')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"lit-element" is a dependency of shared package "lit"')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"@lit/reactive-element" is a dependency of shared package "lit"')
    );

    warnSpy.mockRestore();
    existsSyncMock.mockReset().mockReturnValue(false);
    readFileSyncMock.mockReset().mockReturnValue('{}');
  });

  it('does not exclude shared sub-dependencies in build mode', () => {
    hasPackageDependencyMock.mockReturnValue(false);

    existsSyncMock.mockImplementation(
      (p: string) => p === '/repo/apps/remote/node_modules/lit/package.json'
    );
    readFileSyncMock.mockImplementation((p: string) => {
      if (p === '/repo/apps/remote/node_modules/lit/package.json') {
        return JSON.stringify({
          name: 'lit',
          dependencies: { 'lit-html': '^3.0.0' },
        });
      }
      return '{}';
    });

    const shared: NormalizedShared = {
      lit: {
        name: 'lit',
        from: '',
        version: '3.3.2',
        scope: 'default',
        shareConfig: { singleton: true, requiredVersion: '^3.3.2', strictVersion: false },
      },
      'lit-html': {
        name: 'lit-html',
        from: '',
        version: '3.3.2',
        scope: 'default',
        shareConfig: { singleton: true, requiredVersion: '^3.3.2', strictVersion: false },
      },
    };

    const plugins = proxySharedModule({ shared });
    const proxyPlugin = getProxyPlugin(plugins);
    const config: MockUserConfig = { resolve: { alias: [] } };

    callHook(
      proxyPlugin.config,
      { meta: createPluginMeta() } as unknown as ConfigPluginContext,
      config,
      {
        command: 'build',
        mode: 'production',
      } as ConfigEnv
    );

    // In build mode, sub-dependencies should NOT be excluded
    expect(shared).toHaveProperty('lit');
    expect(shared).toHaveProperty('lit-html');

    existsSyncMock.mockReset().mockReturnValue(false);
    readFileSyncMock.mockReset().mockReturnValue('{}');
  });

  it('uses auto-detected workspace sources in serve prebuild resolution without null deref', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = getProxyPlugin(plugins);
    const prebuildResolvePlugin = getPrebuildResolvePlugin(plugins);
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    callHook(
      proxyPlugin.config,
      {
        meta: createPluginMeta(),
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      } as unknown as ConfigPluginContext,
      config,
      {
        command: 'serve',
        mode: 'development',
      } as ConfigEnv
    );
    callHook(
      proxyPlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        cacheDir: '/vite/deps',
        experimental: { rolldownDev: false },
      } as unknown as ResolvedConfig
    );

    preBuildShareItemMap.set('transitive-no-override', makeShared()['transitive-no-override']);

    const resolution = await callHook(
      prebuildResolvePlugin.resolveId,
      {
        resolve: async (id: string) => ({ id: `/resolved/${id}` }),
      } as any,
      'transitive-no-override__prebuild__',
      '/src/main.ts',
      { isEntry: false }
    );

    expect(resolution).toEqual({
      id: '/resolved//resolved//workspace/packages/transitive-no-override/dist/index.js',
    });
  });

  it('returns already optimized serve prebuild resolutions without waiting for saved ids', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const plugins = proxySharedModule({ shared: makeShared() });
    const proxyPlugin = getProxyPlugin(plugins);
    const prebuildResolvePlugin = getPrebuildResolvePlugin(plugins);
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    callHook(
      proxyPlugin.config,
      {
        meta: createPluginMeta(),
        resolve: async (id: string) => ({ id: `/vite/deps/${id}.js` }),
      } as unknown as ConfigPluginContext,
      config,
      {
        command: 'serve',
        mode: 'development',
      } as ConfigEnv
    );
    callHook(
      proxyPlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        cacheDir: '/vite/deps',
        experimental: { rolldownDev: false },
      } as unknown as ResolvedConfig
    );

    preBuildShareItemMap.set('react', makeShared().react);

    const resolution = await Promise.race([
      callHook(
        prebuildResolvePlugin.resolveId,
        {
          resolve: async (id: string) => ({ id: `/vite/deps/${id}.js` }),
        } as any,
        'react__prebuild__',
        '/src/main.ts',
        { isEntry: false }
      ),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);

    expect(resolution).not.toBe('timeout');
    expect((resolution as { id: string }).id).toBe('/vite/deps/react.js');
  });
});
