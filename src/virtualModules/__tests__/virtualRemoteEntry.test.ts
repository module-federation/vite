import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasPackageDependencyMock,
  normalizedSharedMock,
  usedRemotesMapMock,
  writeSyncSpy,
  optionsMock,
} = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn<(pkg: string) => boolean>(() => false),
  normalizedSharedMock: vi.fn(() => ({})),
  usedRemotesMapMock: vi.fn(() => ({})),
  writeSyncSpy: vi.fn(),
  optionsMock: {
    shareStrategy: 'version-first' as 'version-first' | 'loaded-first',
  },
}));

function getLastCallFirstArg<T>(mockFn: { mock: { calls: T[][] } }): T | undefined {
  const calls = mockFn.mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : undefined;
}

type SharedProviderSelector = (
  versions: Record<string, unknown> | undefined,
  pkg: string,
  share: {
    scope?: string | string[];
    from?: string;
    shareConfig: {
      singleton?: boolean;
      requiredVersion?: string | false;
      strictVersion?: boolean;
    };
  },
  strategy: 'version-first' | 'loaded-first'
) => unknown;

async function getSharedProviderSelector() {
  const [mod, { share: runtimeShare }] = await Promise.all([
    import('../virtualRemoteEntry'),
    import('@module-federation/runtime/helpers'),
  ]);

  return new Function(
    'runtimeShare',
    `${mod.sharedProviderSelectionHelperCode}; return __mfSelectSharedProvider;`
  )(runtimeShare) as SharedProviderSelector;
}

vi.mock('../../utils/VirtualModule', () => {
  return {
    default: class MockVirtualModule {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      getImportId() {
        return `virtual:${this.name}`;
      }

      writeSync = writeSyncSpy;
    },
  };
});

vi.mock('../../utils/packageUtils', () => {
  return {
    getSharedCacheDescriptor: (
      pkg: string,
      shareItem: {
        version?: string;
        scope?: string | string[];
        shareConfig: { singleton?: boolean };
      }
    ) => {
      const normalizedScope = Array.isArray(shareItem.scope) ? shareItem.scope[0] : shareItem.scope;
      const scope = normalizedScope || 'default';
      const id =
        shareItem.shareConfig.singleton || !shareItem.version ? pkg : `${pkg}@${shareItem.version}`;
      return {
        canonical: `${scope}:${id}`,
        ...(scope === 'default' ? { aliases: [id] } : {}),
      };
    },
    getSharedCacheKey: (
      pkg: string,
      shareItem: { version?: string; scope?: string; shareConfig: { singleton?: boolean } }
    ) => {
      const prefix = `${shareItem.scope || 'default'}:`;
      return shareItem.shareConfig.singleton || !shareItem.version
        ? `${prefix}${pkg}`
        : `${prefix}${pkg}@${shareItem.version}`;
    },
    sharedCacheHelperCode: `const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
            const normalizedScope = Array.isArray(scope) ? scope[0] : scope;
            const scopeName = normalizedScope || "default";
            const id = singleton || !version ? pkg : pkg + "@" + version;
            const descriptor = { canonical: scopeName + ":" + id };
            if (scopeName === "default") descriptor.aliases = [id];
            return descriptor;
          };
          const __mfReadSharedCache = (cache, descriptor) => {
            const value = cache[descriptor.canonical];
            if (value !== undefined) return value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              const aliasValue = cache[alias];
              if (aliasValue !== undefined) {
                cache[descriptor.canonical] = aliasValue;
                return aliasValue;
              }
            }
            return undefined;
          };
          const __mfWriteSharedCache = (cache, descriptor, value) => {
            cache[descriptor.canonical] = value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              if (cache[alias] === undefined) cache[alias] = value;
            }
            return value;
          };`,
    hasPackageDependency: hasPackageDependencyMock,
    packageNameEncode: (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_'),
    getPackageName: (packageString: string) => {
      const match = packageString.match(/^(?:@[^/]+\/)?[^/]+/);
      return match ? match[0] : packageString;
    },
    getInstalledPackageJson: (pkg: string) => {
      if (pkg === '@repro/core') {
        return {
          path: '/repo/packages/core/package.json',
          dir: '/repo/packages/core',
          packageJson: {
            name: '@repro/core',
            dependencies: {
              '@repro/shared-lib': 'workspace:*',
            },
          },
        };
      }
      if (pkg === '@repro/shared-lib') {
        return {
          path: '/repo/packages/shared-lib/package.json',
          dir: '/repo/packages/shared-lib',
          packageJson: {
            name: '@repro/shared-lib',
          },
        };
      }
    },
  };
});

vi.mock('../../utils/normalizeModuleFederationOptions', () => {
  return {
    getNormalizeModuleFederationOptions: () => ({
      internalName: '__mfe_internal__host',
      name: 'host',
      filename: 'remoteEntry.js',
      remotes: {},
      shared: normalizedSharedMock(),
      shareScope: 'default',
      runtimePlugins: [],
      shareStrategy: optionsMock.shareStrategy,
    }),
    isExplicitSharedKey: (key: string) => key in normalizedSharedMock(),
    getNormalizeShareItem: (pkg: string) => ({
      name: pkg,
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        import: pkg === 'custom-import' ? '/abs/custom-import.js' : undefined,
        singleton: true,
        requiredVersion: pkg === 'unconstrained' ? false : '^19.2.4',
        strictVersion: false,
      },
    }),
  };
});

vi.mock('../virtualRemotes', () => {
  return {
    getUsedRemotesMap: usedRemotesMapMock,
  };
});

vi.mock('../virtualShared_preBuild', () => {
  return {
    getPreBuildLibImportId: (pkg: string) => `virtual:prebuild:${pkg}`,
    getConcreteSharedImportSource: (
      _pkg: string,
      shareItem?: { shareConfig?: { import?: string | false } }
    ) =>
      typeof shareItem?.shareConfig?.import === 'string' ? shareItem.shareConfig.import : undefined,
    getLocalProviderImportPath: (pkg: string) =>
      pkg === 'transitive-no-override'
        ? '/workspace/packages/transitive-no-override/dist/index.js'
        : undefined,
    getProjectResolvedImportPath: (pkg: string) =>
      pkg === 'wildcard-pkg/button'
        ? '/repo/node_modules/wildcard-pkg/dist/button.js'
        : `/workspace/node_modules/${pkg}/index.js`,
    getSharedImportSource: (
      pkg: string,
      shareItem?: { shareConfig?: { import?: string | false } }
    ) =>
      typeof shareItem?.shareConfig?.import === 'string'
        ? shareItem.shareConfig.import
        : pkg === 'transitive-no-override'
          ? '/workspace/packages/transitive-no-override/dist/index.js'
          : `virtual:prebuild:${pkg}`,
  };
});

describe('virtualRemoteEntry', () => {
  beforeEach(async () => {
    hasPackageDependencyMock.mockReset();
    normalizedSharedMock.mockReset();
    normalizedSharedMock.mockReturnValue({});
    usedRemotesMapMock.mockReset();
    usedRemotesMapMock.mockReturnValue({});
    writeSyncSpy.mockClear();
    optionsMock.shareStrategy = 'version-first';
    vi.resetModules();
  });

  for (const testCase of [
    {
      name: 'keeps react as a direct import in localSharedImportMap when vinext is enabled',
      pkg: 'react',
      hasVinext: true,
      hasAstro: false,
      expectedImport: 'let pkg = await import("react");',
      expectedExportShape: '? (res?.default ?? res)',
      unexpectedImport: 'virtual:shared-provider:react',
    },
    {
      name: 'keeps react as a direct import in localSharedImportMap when astro is enabled',
      pkg: 'react',
      hasVinext: false,
      hasAstro: true,
      expectedImport: 'let pkg = await import("react");',
      expectedExportShape: '? (res?.default ?? res)',
      unexpectedImport: 'virtual:shared-provider:react',
    },
    {
      name: 'uses shared provider for react in localSharedImportMap when vinext is disabled',
      pkg: 'react',
      hasVinext: false,
      hasAstro: false,
      expectedImport: 'let pkg = await import("virtual:prebuild:react");',
      expectedExportShape: ': {...res}',
      unexpectedImport: 'let pkg = await import("react");',
    },
    {
      name: 'uses prebuild import for non-react modules in localSharedImportMap',
      pkg: 'vue',
      hasVinext: true,
      hasAstro: false,
      expectedImport: 'let pkg = await import("virtual:prebuild:vue");',
      expectedExportShape: ': {...res}',
      unexpectedImport: 'let pkg = await import("vue");',
    },
  ]) {
    it(testCase.name, async () => {
      hasPackageDependencyMock.mockImplementation((pkg: string) => {
        if (pkg === 'vinext') return testCase.hasVinext;
        if (pkg === 'astro') return testCase.hasAstro;
        return false;
      });

      const mod = await import('../virtualRemoteEntry');

      mod.getUsedShares().clear();
      mod.addUsedShares(testCase.pkg);

      const code = mod.generateLocalSharedImportMap();

      expect(code).toContain(testCase.expectedImport);
      expect(code).toContain(testCase.expectedExportShape);
      expect(code).not.toContain(testCase.unexpectedImport);
    });
  }

  it('uses configured share import path in localSharedImportMap', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('custom-import');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('let pkg = await import("/abs/custom-import.js");');
    expect(code).not.toContain('virtual:prebuild:custom-import');
  });

  it('uses auto-detected workspace import path in localSharedImportMap', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('transitive-no-override');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain(
      'let pkg = await import("/workspace/packages/transitive-no-override/dist/index.js");'
    );
    expect(code).not.toContain('virtual:prebuild:transitive-no-override');
  });

  it('uses public name in generated shared records', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('from: "host"');
    expect(code).not.toContain('from: "__mfe_internal__host"');
  });

  it('emits requiredVersion: false in generated shared records', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('unconstrained');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('requiredVersion: false');
  });

  it('writes host auto init before init', async () => {
    hasPackageDependencyMock.mockImplementation((pkg: string) => {
      return pkg === 'vinext';
    });

    const mod = await import('../virtualRemoteEntry');

    mod.writeHostAutoInit('virtual:test-remote-entry');

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = getLastCallFirstArg<string>(writeSyncSpy);

    expect(generatedCode).toContain(
      'const remoteEntry = await import("virtual:test-remote-entry");'
    );
    expect(generatedCode).toContain('await remoteEntry.init();');
    expect(generatedCode).not.toContain('.then(remoteEntry.init)');
    expect(generatedCode).not.toContain('.catch(remoteEntry.init)');
  });

  it('inlines a dedicated build-only initResolve bootstrap into remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'build'
    );

    expect(code).toContain('const __mfResolveGlobalKey =');
    expect(code).toContain('const initResolve = __mfResolveState.initResolve;');
    expect(code).not.toContain('import { initResolve } from');
  });

  it('includes __VUE_HMR_RUNTIME__ shim in remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    // Shim must guard against existing runtime
    expect(code).toContain("if (typeof __VUE_HMR_RUNTIME__ === 'undefined')");
    // Shim must provide all three methods Vue's HMR expects
    expect(code).toContain(
      'globalThis.__VUE_HMR_RUNTIME__ = { createRecord() {}, rerender() {}, reload() {} }'
    );
    // Shim must appear before any imports so it's defined when component code executes
    const shimIndex = code.indexOf('__VUE_HMR_RUNTIME__');
    const importIndex = code.indexOf('import {init as runtimeInit');
    expect(shimIndex).toBeLessThan(importIndex);
  });

  it('retries transient shared init module loading failures in serve remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain('const shouldRetrySharedInitError = true &&');
    expect(code).toContain("message.includes('Importing a module script failed')");
    expect(code).toContain("message.includes('Outdated Optimize Dep')");
    expect(code).toContain('attempt >= 19');
    expect(code).toContain('await waitSharedInitRetry(250)');
  });

  it('does not retry shared init module loading failures in build remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'build'
    );

    expect(code).toContain('const shouldRetrySharedInitError = false &&');
  });

  it('clears the cached shared init promise in a rethrowing catch handler so a later call retries', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain('.catch((e) => { localSharedImportMapPromise = undefined; throw e; })');
    expect(code).toContain('.catch((e) => { exposesMapPromise = undefined; throw e; })');
  });

  it('loads local shared state and exposes lazily inside remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'build'
    );

    expect(code).toContain(
      'localSharedImportMapPromise = retrySharedInit(() => import("virtual:mf-localSharedImportMap:__mfe_internal__host"))'
    );
    expect(code).toContain('exposesMapPromise = retrySharedInit(() => import("virtual:exposes"))');
    expect(code).toContain('.then((mod) => mod.default ?? mod)');
    expect(code).toContain('const {usedShared, usedRemotes} = await getLocalSharedImportMap()');
    expect(code).toContain('const exposesMap = await getExposesMap()');
    expect(code).toContain('const mfName = "host"');
    expect(code).toContain('await Promise.all(__mfModuleCache.pendingShareLoads)');
    expect(code).toContain('share.shareConfig?.import !== false');
    expect(code).toContain('const versions = shared?.[pkg]');
    expect(code.indexOf('share.shareConfig?.import !== false')).toBeLessThan(
      code.indexOf('initResolve(initRes)')
    );
    expect(code).not.toContain('initRes.loadShare(pkg');
    expect(code).not.toContain('import exposesMap from');
    expect(code).not.toContain('import {usedShared, usedRemotes} from');
  });

  it('does not eagerly preload remotes during host auto init', async () => {
    usedRemotesMapMock.mockReturnValue({
      remote: new Set(['remote', 'remote/remote-app']),
    });
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(code).not.toContain('runtime.loadRemote("remote")');
    expect(code).not.toContain('runtime.loadRemote("remote/remote-app")');
  });

  it('does not preload generated subpath shares from a root shared package', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('lit/decorators.js');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(code).toContain('Object.entries(usedShared)');
    expect(code).not.toContain('"lit/decorators.js"');
  });

  it('loads the finalized local shared map for host auto init preloads', async () => {
    normalizedSharedMock.mockReturnValue({
      '@repro/core': {
        name: '@repro/core',
        from: '',
        version: '1.0.0',
        scope: 'default',
        shareConfig: {
          singleton: true,
          requiredVersion: '^1.0.0',
          strictVersion: false,
        },
      },
      '@repro/shared-lib': {
        name: '@repro/shared-lib',
        from: '',
        version: '1.0.0',
        scope: 'default',
        shareConfig: {
          singleton: true,
          requiredVersion: '^1.0.0',
          strictVersion: false,
        },
      },
      '@repro/shared-lib/media': {
        name: '@repro/shared-lib/media',
        from: '',
        version: '1.0.0',
        scope: 'default',
        shareConfig: {
          singleton: true,
          requiredVersion: '^1.0.0',
          strictVersion: false,
        },
      },
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/core');
    mod.addUsedShares('@repro/shared-lib');
    mod.addUsedShares('@repro/shared-lib/media');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(code).toContain(
      'const {usedShared} = await import("virtual:mf-localSharedImportMap:__mfe_internal__host")'
    );
    expect(code).toContain('for (const [pkg, share] of Object.entries(usedShared))');
  });

  it('does not seed import:false shared modules in hostAutoInit during build', async () => {
    normalizedSharedMock.mockReturnValue({
      vue: {
        name: 'vue',
        from: '',
        version: '3.5.0',
        scope: 'default',
        shareConfig: {
          singleton: true,
          import: false,
          requiredVersion: '^3.5.0',
          strictVersion: false,
        },
      },
      'some-dep': {
        name: 'some-dep',
        from: '',
        version: '4.0.0',
        scope: 'default',
        shareConfig: {
          singleton: true,
          import: false,
          requiredVersion: '^4.0.0',
          strictVersion: false,
        },
      },
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('vue');
    mod.addUsedShares('some-dep');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    // Build mode must NOT generate static imports for import:false modules
    // to avoid bundler resolution failures on transitive dependencies.
    expect(code).not.toContain('__mfModuleCache.share["default:some-dep"] === undefined');
    expect(code).not.toContain('__mfModuleCache.share["default:vue"] === undefined');
    expect(code).not.toContain('some-dep/dist');
    // The runtime.loadShare loop should still be present
    expect(code).toContain('runtime.loadShare(pkg');
  });

  it('does not preload shares in hostAutoInit with loaded-first', async () => {
    optionsMock.shareStrategy = 'loaded-first';
    normalizedSharedMock.mockReturnValue({
      react: {
        name: 'react',
        from: '',
        version: '19.2.4',
        scope: 'default',
        shareConfig: {
          singleton: true,
          requiredVersion: '19.2.4',
          strictVersion: false,
        },
      },
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');

    expect(code).not.toContain('runtime.loadShare(pkg');
    expect(code).not.toContain('for (const [pkg, share] of Object.entries(usedShared))');
  });

  it('does not register remotes during remoteEntry init with loaded-first', async () => {
    optionsMock.shareStrategy = 'loaded-first';
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {
          remote: {
            entryGlobalName: 'remote',
            name: 'remote',
            type: 'module',
            entry: 'http://localhost:4174/remoteEntry.js',
          },
        },
        shared: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'loaded-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain('remotes: []');
    expect(code).not.toContain('remotes: usedRemotes');
  });

  it('seeds import:false shared modules in hostAutoInit during serve', async () => {
    normalizedSharedMock.mockReturnValue({
      'some-dep': {
        name: 'some-dep',
        from: '',
        version: '4.0.0',
        scope: 'default',
        shareConfig: {
          singleton: true,
          import: false,
          requiredVersion: '^4.0.0',
          strictVersion: false,
        },
      },
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('some-dep');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');

    // Serve mode should still pre-seed the cache (dev server resolves on-demand)
    expect(code).toContain(
      '__mfReadSharedCache(__mfModuleCache.share, {"canonical":"default:some-dep","aliases":["some-dep"]})'
    );
    expect(code).toContain('await import');
  });

  it('emits a scope-aware runtime shared cache descriptor helper', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');

    expect(code).toContain('const normalizedScope = Array.isArray(scope) ? scope[0] : scope;');
    expect(code).toContain('const scopeName = normalizedScope || "default";');
    expect(code).toContain('if (scopeName === "default") descriptor.aliases = [id];');
    expect(code).toContain(
      'const cacheDescriptor = __mfGetSharedCacheDescriptor(pkg, share.shareConfig?.singleton, share.version, share.scope);'
    );
  });

  it('emits shared cache compatibility helpers for host auto init preloads', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');

    expect(code).toContain('const __mfGetSharedCacheDescriptor =');
    expect(code).toContain('__mfReadSharedCache(__mfModuleCache.share, cacheDescriptor)');
    expect(code).toContain('__mfWriteSharedCache(__mfModuleCache.share, cacheDescriptor');
    expect(code).not.toContain('__mfModuleCache.share[cacheKey]');
  });

  it('aliases external singleton providers to the remote share cache key', async () => {
    normalizedSharedMock.mockReturnValue({
      react: {
        name: 'react',
        from: '',
        version: '18.3.1',
        scope: 'default',
        shareConfig: {
          singleton: false,
          requiredVersion: '^18.3.1',
          strictVersion: false,
        },
      },
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: normalizedSharedMock(),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain('const usedShare = usedShared?.[pkg];');
    expect(code).toContain('if (provider.shareConfig?.singleton && usedShare) {');
    expect(code).toContain(
      '__mfWriteSharedCache(__mfModuleCache.share, usedCacheDescriptor, normalized);'
    );
    expect(code).not.toContain('__mfModuleCache.share[usedCacheKey] = normalized;');
  });

  it('reuses an already cached singleton for a versioned remote share key', async () => {
    normalizedSharedMock.mockReturnValue({
      react: {
        name: 'react',
        from: '',
        version: '18.3.1',
        scope: 'default',
        shareConfig: {
          singleton: false,
          requiredVersion: '^18.3.1',
          strictVersion: false,
        },
      },
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: normalizedSharedMock(),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain(
      'const singletonCacheDescriptor = __mfGetSharedCacheDescriptor(pkg, true, share.version, share.scope);'
    );
    expect(code).toContain(
      '__mfWriteSharedCache(__mfModuleCache.share, cacheDescriptor, singletonModule);'
    );
    expect(code.indexOf('const singletonCacheDescriptor')).toBeLessThan(
      code.indexOf('const initRes = runtimeInit({')
    );
  });

  it('does not directly seed import-enabled shared modules before runtime sharing', async () => {
    normalizedSharedMock.mockReturnValue({
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
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: normalizedSharedMock(),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).not.toContain('initRes.loadShare(pkg');
    expect(code).not.toContain(
      'const mod = await import("virtual:mf:remote__prebuild__react__prebuild__.js")'
    );
  });

  it('selects the runtime provider for import:false singleton shares with version-first', async () => {
    const selectProvider = await getSharedProviderSelector();
    const react18 = { from: 'host-react-18', lib: () => ({ marker: 'react-18' }), loaded: true };
    const react19 = { from: 'host-react-19', lib: () => ({ marker: 'react-19' }) };

    expect(
      selectProvider(
        {
          '18.3.1': react18,
          '19.2.7': react19,
        },
        'react',
        {
          shareConfig: {
            singleton: true,
            requiredVersion: '^19.0.0',
          },
        },
        'version-first'
      )
    ).toBe(react19);
  });

  it('prefers an already loaded provider for import:false shares with loaded-first', async () => {
    const selectProvider = await getSharedProviderSelector();
    const loadedReact18 = { from: 'loaded-host-react-18', loaded: true };
    const react19 = { from: 'host-react-19' };

    expect(
      selectProvider(
        {
          '18.3.1': loadedReact18,
          '19.2.7': react19,
        },
        'react',
        {
          shareConfig: {
            singleton: true,
            requiredVersion: '^18.0.0',
          },
        },
        'loaded-first'
      )
    ).toBe(loadedReact18);
  });

  it('matches tilde major ranges when selecting import:false providers', async () => {
    const selectProvider = await getSharedProviderSelector();
    const react100 = { from: 'host-react-1.0.0' };
    const react130 = { from: 'host-react-1.3.0' };
    const react200 = { from: 'host-react-2.0.0' };

    expect(
      selectProvider(
        {
          '1.0.0': react100,
          '1.3.0': react130,
          '2.0.0': react200,
        },
        'react',
        {
          shareConfig: {
            requiredVersion: '~1',
          },
        },
        'version-first'
      )
    ).toBe(react100);
  });

  it('matches hyphen ranges when selecting import:false providers', async () => {
    const selectProvider = await getSharedProviderSelector();
    const dep123 = { from: 'host-dep-1.2.3' };
    const dep234 = { from: 'host-dep-2.3.4' };
    const dep240 = { from: 'host-dep-2.4.0' };

    expect(
      selectProvider(
        {
          '1.2.3': dep123,
          '2.3.4': dep234,
          '2.4.0': dep240,
        },
        'dep',
        {
          shareConfig: {
            requiredVersion: '1.2.3 - 2.3.4',
          },
        },
        'version-first'
      )
    ).toBe(dep123);
  });

  it('does not import runtime share helpers when no import:false share is configured', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).not.toContain(
      'import {share as runtimeShare} from "@module-federation/runtime/helpers";'
    );
    expect(code).not.toContain('const __mfSelectSharedProvider');
  });

  it('uses provider selection helper for import:false remote entry bridging', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: {
          react: {
            name: 'react',
            version: '19.2.0',
            scope: ['default'],
            shareConfig: {
              singleton: true,
              import: false,
              requiredVersion: '^19.0.0',
            },
          },
        },
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain(
      'import {share as runtimeShare} from "@module-federation/runtime/helpers";'
    );
    expect(code).toContain("__mfSelectSharedProvider(versions, pkg, share, 'version-first')");
    expect(code).not.toContain('versions[Object.keys(versions)[0]]');
  });

  it('uses provider selection helper before seeding import:false shares from the global share scope', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: {
          react: {
            name: 'react',
            version: '19.2.0',
            scope: ['default'],
            shareConfig: {
              singleton: true,
              import: false,
              requiredVersion: '^19.0.0',
            },
          },
        },
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain('const usedShare = usedShared?.[pkg];');
    expect(code).toContain('const providerEntries = usedShare?.shareConfig?.import === false');
    expect(code).toContain("__mfSelectSharedProvider(versionMap, pkg, usedShare, 'version-first')");
    expect(code.indexOf('__mfSelectSharedProvider(versionMap')).toBeLessThan(
      code.indexOf('for (const [version, provider] of providerEntries)')
    );
  });
});
