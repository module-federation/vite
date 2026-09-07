import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasPackageDependencyMock,
  normalizedSharedMock,
  normalizedRemotesMock,
  usedRemotesMapMock,
  writeSyncSpy,
  optionsMock,
} = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn<(pkg: string) => boolean>(() => false),
  normalizedSharedMock: vi.fn(() => ({})),
  normalizedRemotesMock: vi.fn(() => ({})),
  usedRemotesMapMock: vi.fn(() => ({})),
  writeSyncSpy: vi.fn(),
  optionsMock: {
    shareStrategy: 'version-first' as 'version-first' | 'loaded-first',
    injectTreeShakingUsedExports: undefined as boolean | undefined,
    treeSharedImportFalse: false,
    treeSharedProvider: true,
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

async function getSharedProviderEntryResolver() {
  const mod = await import('../virtualRemoteEntry');

  return new Function(
    `${mod.sharedProviderSelectionHelperCode}; return __mfFindSharedProviderEntry;`
  )() as (
    versions: Record<string, unknown> | undefined,
    provider: unknown
  ) => { version: string; provider: unknown; registered: boolean } | undefined;
}

async function getExternalSharedProviderSelector() {
  const [mod, { share: runtimeShare }] = await Promise.all([
    import('../virtualRemoteEntry'),
    import('@module-federation/runtime/helpers'),
  ]);

  return new Function(
    'runtimeShare',
    `${mod.sharedProviderSelectionHelperCode}\n${mod.externalSharedProviderSelectionHelperCode}; return __mfSelectExternalSharedProvider;`
  )(runtimeShare) as (
    versions: Record<string, unknown> | undefined,
    pkg: string,
    localShare: Parameters<SharedProviderSelector>[2] & {
      version: string;
      loaded?: boolean | number;
      lib?: () => unknown;
      loading?: Promise<unknown>;
      get?: () => unknown;
    },
    strategy: 'version-first' | 'loaded-first'
  ) => unknown;
}

async function getScopeRootProviderResolver() {
  const mod = await import('../virtualRemoteEntry');

  return new Function(
    `${mod.externalSharedProviderSelectionHelperCode}; return __mfGetScopeRootProvider;`
  )() as (
    instances: unknown[],
    scopeRoot: unknown,
    shared: unknown,
    scopeName: string,
    pkg: string,
    version: string,
    provider: unknown,
    passedProvider: unknown,
    strategy: 'version-first' | 'loaded-first'
  ) => unknown;
}

async function getExternalSharedProviderResolver() {
  const mod = await import('../virtualRemoteEntry');

  return new Function(
    `${mod.externalSharedProviderSelectionHelperCode}; return __mfResolveExternalSharedProvider;`
  )() as (
    instances: unknown[],
    scopeRoot: unknown,
    shared: unknown,
    scopeName: string,
    pkg: string,
    providerEntry: { version: string; provider: unknown; registered: boolean },
    selectedExternalProvider: unknown,
    passedProvider: unknown,
    strategy: 'version-first' | 'loaded-first'
  ) => { provider: unknown; scopeRootProvider: unknown } | undefined;
}

type RuntimeBridgeProvider = {
  from: string;
  version?: string;
  scope?: string | string[];
  get?: () => Promise<() => unknown> | (() => unknown);
  lib?: () => unknown;
  loaded?: boolean;
  loading?: Promise<() => unknown>;
  strategy?: string;
};

type RuntimeResolveShareArgs = {
  shareInfo?: Record<string, unknown>;
  shareScopeMap?: Record<string, Record<string, Record<string, RuntimeBridgeProvider>>>;
  resolver: (...args: unknown[]) => {
    shared: RuntimeBridgeProvider;
    useTreesShaking?: boolean;
  };
};

async function getRuntimeBridgeLoader(
  initRes: {
    loadShare: (pkg: string, options: unknown) => Promise<unknown>;
  },
  resolveShare?: (args: RuntimeResolveShareArgs) => RuntimeResolveShareArgs | undefined
) {
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
  const lifecycleStateCode = code.slice(
    code.indexOf('const __mfRuntimeShareLoadIdKey ='),
    code.indexOf('const initRes = runtimeInit({')
  );
  const lifecyclePluginCode = code.slice(
    code.indexOf('function __mfSharePinLifecyclePlugin()'),
    code.indexOf('const runtimeResolveShareHook =')
  );
  const runtimeBridgeCode = code.slice(
    code.indexOf('const __mfRuntimeProviderOrigins ='),
    code.indexOf('const bridgedProviders =')
  );
  const helperCode = `${lifecycleStateCode}\n${lifecyclePluginCode}\n${runtimeBridgeCode}`;

  let recordSelection = (
    _provider: RuntimeBridgeProvider,
    _shareInfo?: Record<string, unknown>,
    _shareScopeMap?: RuntimeResolveShareArgs['shareScopeMap']
  ) => {};
  let runtimeResolveShareListener = (args: RuntimeResolveShareArgs) => args;
  const runtimeResolveShareHook = {
    on(listener: (args: RuntimeResolveShareArgs) => RuntimeResolveShareArgs) {
      runtimeResolveShareListener = listener;
    },
  };
  const helpers = new Function(
    'initRes',
    'runtimeResolveShareHook',
    `${helperCode}; return {
      loadPinnedShare: __mfLoadPinnedRuntimeShare,
      pinLifecyclePlugin: __mfSharePinLifecyclePlugin()
    };`
  )(initRes, runtimeResolveShareHook) as {
    loadPinnedShare: (
      pkg: string,
      shareConfig: Record<string, unknown>,
      versionMap: Record<string, RuntimeBridgeProvider>,
      version: string,
      currentProvider: RuntimeBridgeProvider | undefined,
      provider: RuntimeBridgeProvider,
      providerRegistered?: boolean
    ) => Promise<
      | {
          provider: RuntimeBridgeProvider;
          selection: {
            provider: RuntimeBridgeProvider;
            version: string;
            from: string;
            registered: boolean;
          };
          resolved: unknown;
        }
      | undefined
    >;
    pinLifecyclePlugin: {
      resolveShare: (args: RuntimeResolveShareArgs) => RuntimeResolveShareArgs;
    };
  };
  recordSelection = (provider, shareInfo, shareScopeMap) => {
    let args: RuntimeResolveShareArgs = {
      shareInfo,
      shareScopeMap,
      resolver: () => ({ shared: provider }),
    };
    args = helpers.pinLifecyclePlugin.resolveShare(args) || args;
    args = resolveShare?.(args) || args;
    args = runtimeResolveShareListener(args) || args;
    args.resolver();
  };
  const loadPinnedShare = helpers.loadPinnedShare as typeof helpers.loadPinnedShare & {
    recordSelection(
      provider: RuntimeBridgeProvider,
      shareInfo?: Record<string, unknown>,
      shareScopeMap?: RuntimeResolveShareArgs['shareScopeMap']
    ): void;
  };
  loadPinnedShare.recordSelection = (provider, shareInfo, shareScopeMap) =>
    recordSelection(provider, shareInfo, shareScopeMap);
  return loadPinnedShare;
}

function createRuntimeShareLoader(versionMap: Record<string, RuntimeBridgeProvider>) {
  return async (
    _pkg: string,
    options: { customShareInfo?: { shareConfig?: { requiredVersion?: string } } }
  ) => {
    const version = options.customShareInfo?.shareConfig?.requiredVersion;
    if (!version) return false;
    const provider = versionMap[version];
    if (provider.lib) return provider.lib;
    if (provider.loading && !provider.loaded) {
      const factory = await provider.loading;
      provider.lib ??= factory;
      provider.loaded = true;
      return factory;
    }
    if (!provider.get) return false;
    const loading = Promise.resolve(provider.get());
    provider.loading = loading;
    const factory = await loading;
    provider.lib = factory;
    provider.loaded = true;
    return factory;
  };
}

function getRuntimeSeedCode(code: string) {
  const start = code.indexOf('const __mfSeedOrder =');
  const endMarker = 'await __mfSeedLocalShared(__mfImmediateSeedKeys);';
  const end = code.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('runtime seed code not found');
  return code.slice(start, end + endMarker.length);
}

function getRuntimeDeferredResolutionCode(code: string) {
  const start = code.indexOf('const __mfReadyDeferredSeedKeys = [];');
  const endMarker = 'await __mfSeedLocalShared(__mfReadyDeferredSeedKeys);';
  const end = code.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('runtime deferred resolution code not found');
  return code.slice(start, end + endMarker.length);
}

vi.mock('../../utils/VirtualModule', () => {
  return {
    MF_OWNER_INFIX: '__mf_owner__',
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
              if (!Object.prototype.hasOwnProperty.call(cache, alias)) continue;
              const aliasValue = cache[alias];
              if (aliasValue !== undefined) {
                cache[descriptor.canonical] = aliasValue;
                return aliasValue;
              }
            }
            return undefined;
          };
          const __mfSharedCacheListenersKey = Symbol.for("module-federation.shared-cache-listeners");
          const __mfGetSharedCacheListeners = (cache) => {
            let listeners = cache[__mfSharedCacheListenersKey];
            if (listeners === undefined) {
              listeners = Object.create(null);
              Object.defineProperty(cache, __mfSharedCacheListenersKey, {
                value: listeners,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return listeners;
          };
          const __mfSubscribeSharedCache = (cache, descriptor, listener) => {
            const listeners = __mfGetSharedCacheListeners(cache);
            (listeners[descriptor.canonical] ||= new Set()).add(listener);
          };
          const __mfSharedCacheOwnersKey = Symbol.for("module-federation.shared-cache-owners");
          const __mfGetSharedCacheOwners = (cache) => {
            let owners = cache[__mfSharedCacheOwnersKey];
            if (owners === undefined) {
              owners = Object.create(null);
              Object.defineProperty(cache, __mfSharedCacheOwnersKey, {
                value: owners,
                enumerable: false,
                configurable: false,
                writable: false
              });
            }
            return owners;
          };
          const __mfReadSharedCacheOwner = (cache, descriptor) =>
            cache[__mfSharedCacheOwnersKey]?.[descriptor.canonical];
          const __mfWriteSharedCache = (cache, descriptor, value, owner) => {
            cache[descriptor.canonical] = value;
            const aliases = descriptor.aliases || [];
            for (const alias of aliases) {
              Object.defineProperty(cache, alias, {
                value,
                enumerable: true,
                configurable: true,
                writable: true
              });
            }
            const owners = cache[__mfSharedCacheOwnersKey];
            if (owner === undefined) {
              if (owners) delete owners[descriptor.canonical];
            } else {
              __mfGetSharedCacheOwners(cache)[descriptor.canonical] = owner;
            }
            const listeners = cache[__mfSharedCacheListenersKey]?.[descriptor.canonical];
            if (listeners) {
              for (const listener of listeners) listener(value);
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
      if (pkg === '@repro/aaa-host-only') {
        return {
          path: '/repo/packages/aaa-host-only/package.json',
          dir: '/repo/packages/aaa-host-only',
          packageJson: {
            name: '@repro/aaa-host-only',
            dependencies: { '@repro/zzz-consumer': 'workspace:*' },
          },
        };
      }
      if (pkg === '@repro/zzz-consumer') {
        return {
          path: '/repo/packages/zzz-consumer/package.json',
          dir: '/repo/packages/zzz-consumer',
          packageJson: {
            name: '@repro/zzz-consumer',
            dependencies: { '@repro/aaa-host-only': 'workspace:*' },
          },
        };
      }
      if (pkg === '@repro/react-consumer') {
        return {
          path: '/repo/packages/react-consumer/package.json',
          dir: '/repo/packages/react-consumer',
          packageJson: {
            name: '@repro/react-consumer',
            dependencies: {
              react: '^19.0.0',
            },
          },
        };
      }
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
      remotes: normalizedRemotesMock(),
      shared: normalizedSharedMock(),
      shareScope: 'default',
      runtimePlugins: [],
      shareStrategy: optionsMock.shareStrategy,
      injectTreeShakingUsedExports: optionsMock.injectTreeShakingUsedExports,
    }),
    isExplicitSharedKey: (key: string) => key in normalizedSharedMock(),
    getNormalizeShareItem: (pkg: string) => ({
      name: pkg,
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        import:
          pkg === 'host-only'
            ? false
            : pkg === 'custom-import'
              ? '/abs/custom-import.js'
              : pkg === 'tree-shared' && optionsMock.treeSharedImportFalse
                ? false
                : undefined,
        singleton: pkg !== 'non-singleton',
        requiredVersion: pkg === 'unconstrained' ? false : '^19.2.4',
        strictVersion: false,
        eager: pkg === 'eager-shared',
        ...(pkg === 'tree-shared' || pkg === 'unknown-tree-shared'
          ? { treeShaking: { mode: 'runtime-infer', usedExports: ['Button'] } }
          : {}),
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
    getLoadShareModulePath: (pkg: string) => `virtual:loadShare:${pkg}`,
    getTreeShakingSharedProviderImportId: (pkg: string) => `virtual:tree-provider:${pkg}`,
    getSharedNamedExports: (pkg: string) =>
      pkg === 'named-singleton'
        ? ['namedExport']
        : pkg === 'unknown-exports-singleton' || pkg === 'unknown-tree-shared'
          ? undefined
          : [],
    hasTreeShakingSharedProvider: (pkg: string) =>
      pkg === 'tree-shared' && optionsMock.treeSharedProvider,
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
    normalizedRemotesMock.mockReset();
    normalizedRemotesMock.mockReturnValue({});
    usedRemotesMapMock.mockReset();
    usedRemotesMapMock.mockReturnValue({});
    writeSyncSpy.mockClear();
    optionsMock.shareStrategy = 'version-first';
    optionsMock.injectTreeShakingUsedExports = undefined;
    optionsMock.treeSharedImportFalse = false;
    optionsMock.treeSharedProvider = true;
    vi.resetModules();
  });

  it('partitions used shares by normalized plugin options', async () => {
    const mod = await import('../virtualRemoteEntry');
    const optionsA = { internalName: 'shared-name' } as never;
    const optionsB = { internalName: 'shared-name' } as never;

    mod.addUsedShares('share-a', optionsA);
    mod.addUsedShares('share-b', optionsB);

    expect([...mod.getUsedShares(optionsA)]).toEqual(['share-a']);
    expect([...mod.getUsedShares(optionsB)]).toEqual(['share-b']);
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
      expectedExportShape: ': __mfNormalizeRuntimeShare({...res})',
      unexpectedImport: 'let pkg = await import("react");',
    },
    {
      name: 'uses prebuild import for non-react modules in localSharedImportMap',
      pkg: 'vue',
      hasVinext: true,
      hasAstro: false,
      expectedImport: 'let pkg = await import("virtual:prebuild:vue");',
      expectedExportShape: ': __mfNormalizeRuntimeShare({...res})',
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

  it('unwraps default-only CJS namespaces in local shared getters', async () => {
    const mod = await import('../virtualRemoteEntry');
    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const reactModule = {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { S: 'dispatcher' },
    };
    const code = mod
      .generateLocalSharedImportMap()
      .replace(
        'import {loadShare} from "@module-federation/runtime";',
        'const loadShare = () => {};'
      )
      .replace('import("virtual:prebuild:react")', 'Promise.resolve({ default: reactModule })')
      .replace(/export \{\s*usedShared,\s*usedRemotes\s*\}/, 'return { usedShared, usedRemotes }');
    const generated = new Function('reactModule', code)(reactModule);
    const factory = await generated.usedShared.react.get();

    expect(factory()).toBe(reactModule);
    expect(factory().__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.S).toBe(
      'dispatcher'
    );
  });

  it('materializes direct React for vinext RSC hosts', async () => {
    hasPackageDependencyMock.mockImplementation((pkg: string) => pkg === 'vinext');
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');
    mod.addUsedShares('react/jsx-runtime');

    const code = mod.generateLocalSharedImportMap();
    expect(code).toMatch(/"react": \{[\s\S]*?materialize: true,/);
    expect(code).toMatch(/"react\/jsx-runtime": \{[\s\S]*?materialize: true,/);

    const serverInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');
    const clientInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build', undefined, [
      'browser',
    ]);
    const workerInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build', undefined, [
      'worker',
      'browser',
    ]);
    expect(serverInit).toContain('const localFactory = await share.get()');
    expect(clientInit).not.toContain('const localFactory = await share.get()');
    expect(workerInit).toContain('const localFactory = await share.get()');
  });

  it('uses configured share import path in localSharedImportMap', async () => {
    hasPackageDependencyMock.mockReturnValue(false);

    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('custom-import');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('let pkg = await import("/abs/custom-import.js");');
    expect(code).not.toContain('virtual:prebuild:custom-import');
  });

  it('marks only export-complete shared proxies as rebindable', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    for (const pkg of [
      'host-only',
      'non-singleton',
      'named-singleton',
      'default-only-singleton',
      'unknown-exports-singleton',
    ]) {
      mod.addUsedShares(pkg);
    }

    const code = mod.generateLocalSharedImportMap();
    const canLiveRebind = (pkg: string) =>
      code.match(
        new RegExp(`${JSON.stringify(pkg)}: \\{[\\s\\S]*?canLiveRebind: (true|false),`)
      )?.[1];

    expect(canLiveRebind('host-only')).toBe('true');
    expect(canLiveRebind('non-singleton')).toBe('true');
    expect(canLiveRebind('named-singleton')).toBe('true');
    expect(canLiveRebind('default-only-singleton')).toBe('true');
    expect(canLiveRebind('unknown-exports-singleton')).toBe('false');
  });

  it('disables runtime tree selection when export coverage is unknown', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('unknown-tree-shared');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('"unknown-tree-shared": {');
    expect(code).toContain('canLiveRebind: false');
    expect(code).not.toContain('treeShaking: {');
    expect(code).not.toContain('virtual:tree-provider:unknown-tree-shared');
  });

  it('statically imports eager shared providers and emits eager runtime metadata', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('eager-shared');
    mod.addUsedShares('vue');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('import * as __mfEagerShare_0 from "virtual:prebuild:eager-shared";');
    expect(code).toContain('let pkg = __mfEagerShare_0;');
    expect(code).toContain('let pkg = await import("virtual:prebuild:vue");');
    expect(code).toContain('eager: true');
    expect(code).toMatch(/loaded: false,\s+materialize: true,\s+eager: true,\s+from: "host"/);
  });

  it('expands eager react/ prefix into concrete shared modules, never the prefix string', async () => {
    const mod = await import('../virtualRemoteEntry');
    const options = {
      internalName: '__mfe_internal__react_prefix',
      name: 'react-prefix-host',
      filename: 'remoteEntry.js',
      shared: {
        'react/': {
          name: 'react/',
          from: '',
          version: '19.2.4',
          scope: 'default',
          shareConfig: {
            singleton: true,
            eager: true,
            import: false,
            requiredVersion: '^19.2.4',
            strictVersion: false,
          },
        },
      },
      shareScope: 'default',
      runtimePlugins: [],
      shareStrategy: 'version-first',
    } as any;

    mod.addUsedShares('react/jsx-runtime', options);
    mod.addUsedShares('react/jsx-dev-runtime', options);

    const code = mod.generateLocalSharedImportMap(options);

    expect(code).toMatch(/"react": \{[\s\S]*?materialize: true,/);
    expect(code).toMatch(/"react\/jsx-runtime": \{[\s\S]*?materialize: true,/);
    expect(code).toMatch(/"react\/jsx-dev-runtime": \{[\s\S]*?materialize: true,/);
    expect(code).not.toMatch(/"react\/": \{/);
  });

  it('registers configured shares without materializing unused providers', async () => {
    const mod = await import('../virtualRemoteEntry');
    const options = {
      internalName: '__mfe_internal__lazy',
      name: 'lazy',
      shared: normalizedSharedMock(),
    } as any;
    mod.addConfiguredShare('vue', options);
    mod.addConfiguredShare('react', options);
    mod.addUsedShares('react', options);

    const code = mod.generateLocalSharedImportMap(options);
    expect(code).toMatch(/"vue": \{[\s\S]*?materialize: false,/);
    expect(code).toMatch(/"react": \{[\s\S]*?materialize: true,/);
  });

  it('keeps the full getter and emits a separate runtime-infer provider getter', async () => {
    const { setTreeShakingBuildMode } = await import('../../utils/treeShaking');
    setTreeShakingBuildMode(true);
    try {
      const mod = await import('../virtualRemoteEntry');
      mod.getUsedShares().clear();
      mod.addUsedShares('tree-shared');

      const code = mod.generateLocalSharedImportMap();

      expect(code).toContain('let pkg = await import("virtual:prebuild:tree-shared");');
      expect(code).toContain('usedExports: ["Button"]');
      expect(code).toContain(
        'const container = await import("virtual:tree-provider:tree-shared");'
      );
      expect(code).toContain('return container.get();');
      expect(code).not.toContain('cacheKey:');
    } finally {
      setTreeShakingBuildMode(false);
    }
  });

  it('falls back to the complete provider when runtime export injection is disabled', async () => {
    const { setTreeShakingBuildMode } = await import('../../utils/treeShaking');
    setTreeShakingBuildMode(true);
    optionsMock.injectTreeShakingUsedExports = false;
    try {
      const mod = await import('../virtualRemoteEntry');
      mod.getUsedShares().clear();
      mod.addUsedShares('tree-shared');

      const code = mod.generateLocalSharedImportMap();

      expect(code).toContain('status: 0');
      expect(code).not.toContain('virtual:tree-provider:tree-shared');
      expect(code).toContain('let pkg = await import("virtual:prebuild:tree-shared");');
    } finally {
      setTreeShakingBuildMode(false);
    }
  });

  it('lets import:false runtime-infer consumers select a compatible host provider', async () => {
    const { setTreeShakingBuildMode } = await import('../../utils/treeShaking');
    setTreeShakingBuildMode(true);
    optionsMock.treeSharedImportFalse = true;
    optionsMock.treeSharedProvider = false;
    try {
      const mod = await import('../virtualRemoteEntry');
      mod.getUsedShares().clear();
      mod.addUsedShares('tree-shared');

      const code = mod.generateLocalSharedImportMap();

      expect(code).toContain('import: false');
      expect(code).toContain('status: 1');
      expect(code).not.toContain('virtual:tree-provider:tree-shared');
    } finally {
      setTreeShakingBuildMode(false);
    }
  });

  it('rejects runtime-infer providers whose export coverage is incomplete', async () => {
    const { treeShakingResolveShareBodyCode } = await import('../virtualRemoteEntry');
    const applyResolveShare = new Function('args', treeShakingResolveShareBodyCode) as (
      args: any
    ) => any;
    const selected = {
      get: vi.fn(),
      treeShaking: { usedExports: ['Button'], get: vi.fn() },
    };
    const local: any = {
      get: vi.fn(),
      treeShaking: {
        mode: 'runtime-infer',
        usedExports: ['Button', 'Input'],
        providedExports: ['Button', 'Input'],
        get: vi.fn(),
      },
    };
    const args = applyResolveShare({
      shareInfo: local,
      resolver: () => ({ shared: selected, useTreesShaking: true }),
    });

    expect(args.resolver()).toEqual({ shared: local, useTreesShaking: true });

    delete local.treeShaking.get;
    expect(args.resolver()).toEqual({ shared: selected, useTreesShaking: false });
  });

  it('keeps a runtime-infer provider whose export coverage satisfies the consumer', async () => {
    const { treeShakingResolveShareBodyCode } = await import('../virtualRemoteEntry');
    const applyResolveShare = new Function('args', treeShakingResolveShareBodyCode) as (
      args: any
    ) => any;
    const selected = {
      treeShaking: { usedExports: ['Button', 'Input', 'Select'], get: vi.fn() },
    };
    const originalResult = { shared: selected, useTreesShaking: true };
    const args = applyResolveShare({
      shareInfo: {
        treeShaking: {
          mode: 'runtime-infer',
          usedExports: ['Button', 'Input'],
        },
      },
      resolver: () => originalResult,
    });

    expect(args.resolver()).toBe(originalResult);
  });

  it('does not wrap the resolver for a non-tree-shaking consumer', async () => {
    const { treeShakingResolveShareBodyCode } = await import('../virtualRemoteEntry');
    const applyResolveShare = new Function('args', treeShakingResolveShareBodyCode) as (
      args: any
    ) => any;
    const resolver = vi.fn(() => ({ shared: {}, useTreesShaking: false }));

    const args = applyResolveShare({ shareInfo: {}, resolver });

    expect(args.resolver).toBe(resolver);
  });

  it('orders React before shared packages that evaluate React APIs', async () => {
    const share = (name: string) => ({
      name,
      version: '19.2.4',
      scope: 'default',
      shareConfig: { singleton: true, strictVersion: false },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/react-consumer': share('@repro/react-consumer'),
      react: share('react'),
    });

    const mod = await import('../virtualRemoteEntry');
    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/react-consumer');
    mod.addUsedShares('react');

    const localMap = mod.generateLocalSharedImportMap();
    const hostInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');

    expect(localMap.indexOf('"react":')).toBeLessThan(localMap.indexOf('"@repro/react-consumer":'));
    expect(hostInit).toContain(
      'const __mfHostInitShareBatches = [["react"],["@repro/react-consumer"]]'
    );
  });

  it('lists still-unseeded share wrappers for the build bootstrap outside hostInit', async () => {
    const share = (name: string, importFalse = false) => ({
      name,
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        strictVersion: false,
        ...(importFalse ? { import: false as const } : {}),
      },
    });
    normalizedSharedMock.mockReturnValue({
      react: share('react'),
      '@repro/host-only': share('@repro/host-only', true),
      '@repro/react-consumer': share('@repro/react-consumer'),
    });
    const mod = await import('../virtualRemoteEntry');
    mod.getUsedShares().clear();
    mod.addUsedShares('react');
    mod.addUsedShares('@repro/host-only');
    mod.addUsedShares('@repro/react-consumer');

    const buildCode = mod.generatePendingSharesCode('build');
    // Wrappers of shares with a local fallback are listed; an import:false share has nothing to seed.
    expect(buildCode).toContain(
      'const __mfPendingShareImports = [["react", () => import("virtual:loadShare:react")], ["@repro/react-consumer", () => import("virtual:loadShare:@repro/react-consumer")]];'
    );
    expect(buildCode).toContain('export async function preloadPendingShares()');
    expect(buildCode).toContain(
      'if (__mfReadSharedCache(__mfModuleCache.share, cacheDescriptor) !== undefined) return;'
    );

    const serveCode = mod.generatePendingSharesCode('serve');
    expect(serveCode).toContain('const __mfPendingShareImports = [];');

    // hostInit itself stays free of wrapper references (remote-entry isolation).
    const hostInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');
    expect(hostInit).not.toContain('__loadShare__');
    expect(hostInit).not.toContain('preloadPendingShares');
  });

  it('orders React package roots before their subpath shares', async () => {
    const share = (name: string) => ({
      name,
      version: '18.3.1',
      scope: 'default',
      shareConfig: { singleton: true, strictVersion: false },
    });
    normalizedSharedMock.mockReturnValue({
      'react/jsx-runtime': share('react/jsx-runtime'),
      react: share('react'),
      'react-dom/client': share('react-dom/client'),
      'react-dom': share('react-dom'),
    });

    const mod = await import('../virtualRemoteEntry');
    mod.getUsedShares().clear();
    mod.addUsedShares('react/jsx-runtime');
    mod.addUsedShares('react');
    mod.addUsedShares('react-dom/client');
    mod.addUsedShares('react-dom');

    const hostInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');
    const batchesMarker = 'const __mfHostInitShareBatches = ';
    const batchesStart = hostInit.indexOf(batchesMarker);
    const batchesLineEnd = hostInit.indexOf('\n', batchesStart);
    const batchesSource =
      batchesStart === -1 || batchesLineEnd === -1
        ? '[]'
        : hostInit.slice(batchesStart + batchesMarker.length, batchesLineEnd).trim();
    const batches = JSON.parse(
      batchesSource.endsWith(';') ? batchesSource.slice(0, -1) : batchesSource
    ) as string[][];
    const order = batches.flat();

    expect(order.indexOf('react')).toBeLessThan(order.indexOf('react/jsx-runtime'));
    expect(order.indexOf('react-dom')).toBeLessThan(order.indexOf('react-dom/client'));
    // react and react-dom have no dependency relationship, so they batch together.
    expect(batches[0]).toEqual(expect.arrayContaining(['react', 'react-dom']));
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

  it('keeps shares registered on the runtime before initShareScopeMap', async () => {
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

    expect(code).toContain('const __mfKeepRegisteredShares = (scopeName, scope) => {');
    expect(code).toContain('Object.entries(initRes.shareScopeMap?.[scopeName] || {})');
    expect(code).toContain('if (!provider || provider.get === usedShared[pkg]?.get) continue;');
    expect(code).toContain('if (target[version] === undefined) target[version] = provider;');
    expect(code).toContain(
      'const __mfGetRuntimeShareScope = (scopeName, hostScope) => {\n      __mfKeepRegisteredShares(scopeName, hostScope);'
    );
    expect(code.indexOf('const initRes = runtimeInit({')).toBeLessThan(
      code.indexOf(
        "initRes.initShareScopeMap(\n      'default',\n      __mfGetRuntimeShareScope('default', shared)"
      )
    );
  });

  it('skips host init loadShare for import:false shares without a foreign provider', async () => {
    const mod = await import('../virtualRemoteEntry');

    const hostInit = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(hostInit).toContain('share.shareConfig?.import === false &&');
    expect(hostInit).toContain(
      'Object.values(runtime.shareScopeMap?.[scopeName]?.[pkg] || {}).some('
    );
    expect(hostInit).toContain('(provider) => provider?.shareConfig?.import !== false');
    expect(hostInit.indexOf('share.shareConfig?.import === false &&')).toBeLessThan(
      hostInit.indexOf('await runtime.loadShare(pkg, {')
    );
  });

  it('initializes all configured provider share scopes in remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: ['default', 'scope1'],
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'build'
    );

    expect(code).toContain('const shareScopeNames = Array.isArray(["default","scope1"])');
    expect(code).toContain('const getShareScopeName = (pkg, share) =>');
    expect(code).toContain('return [...new Set([...configuredScopes, ...shareScopeNames])]');
    expect(code).toContain('getShareScope(getShareScopeName(pkg, usedShare))');
    expect(code).toContain('for (const shareScopeName of shareScopeNames)');
    expect(code).toContain(
      'initRes.initShareScopeMap(\n        shareScopeName,\n        __mfGetRuntimeShareScope(shareScopeName, scopeShare)\n      );'
    );
    expect(code).toContain('initRes.initializeSharing(shareScopeName');
  });

  it('mirrors resolved manifest snapshots under the real container name', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'loaded-first',
      } as any,
      'virtual:exposes',
      'build'
    );

    const pluginCode = code.slice(
      code.indexOf('function __mfRealNameSnapshotPlugin()'),
      code.indexOf('const runtimeResolveShareHook =')
    );
    const plugin = new Function(`${pluginCode}; return __mfRealNameSnapshotPlugin();`)() as {
      afterLoadSnapshot: (args: { remoteSnapshot: Record<string, string> }) => unknown;
    };

    const manifestUrl = 'https://cdn.invalid/provider/mf-manifest.json';
    const moduleInfo: Record<string, unknown> = {
      [`__mfe_internal__host__mf_owner__1__alias:${manifestUrl}`]: {},
      // The provider's own entry, which shadows a real-name lookup.
      provider: { version: manifestUrl, remoteEntry: '' },
    };
    const federationGlobal = globalThis as { __FEDERATION__?: unknown };
    const hadFederationGlobal = '__FEDERATION__' in federationGlobal;
    const previous = federationGlobal.__FEDERATION__;
    federationGlobal.__FEDERATION__ = { moduleInfo };

    try {
      const remoteSnapshot = {
        globalName: 'provider',
        version: manifestUrl,
        remoteEntry: 'remoteEntry.js',
      };
      plugin.afterLoadSnapshot({ remoteSnapshot });
      expect(moduleInfo[`provider:${manifestUrl}`]).toBe(remoteSnapshot);

      plugin.afterLoadSnapshot({
        remoteSnapshot: { globalName: 'other', version: manifestUrl, remoteEntry: '' },
      });
      expect(`other:${manifestUrl}` in moduleInfo).toBe(false);

      plugin.afterLoadSnapshot({ remoteSnapshot: { ...remoteSnapshot } });
      expect(moduleInfo[`provider:${manifestUrl}`]).toBe(remoteSnapshot);
    } finally {
      if (hadFederationGlobal) {
        federationGlobal.__FEDERATION__ = previous;
      } else {
        delete federationGlobal.__FEDERATION__;
      }
    }
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

    expect(code).toMatch(
      /localSharedImportMapPromise = retrySharedInit\(\(\) => import\("virtual:mf-localSharedImportMap:__mfe_internal__host__mf_owner__\d+"\)\)/
    );
    expect(code).toContain('exposesMapPromise = retrySharedInit(() => import("virtual:exposes"))');
    expect(code).toContain('.then((mod) => mod.default ?? mod)');
    expect(code).toContain('const {usedShared, usedRemotes} = await getLocalSharedImportMap()');
    expect(code).toContain('const __mfGetPendingExternalSharedProvider =');
    expect(code).toContain('const exposesMap = await getExposesMap()');
    expect(code).toContain('const mfName = "host"');
    expect(code).toContain('await Promise.all(__mfModuleCache.pendingShareLoads)');
    expect(code).toContain('share.shareConfig?.import !== false');
    expect(code).toContain('const versionMap = shared?.[pkg]');
    expect(code.indexOf('share.shareConfig?.import !== false')).toBeLessThan(
      code.indexOf('initResolve(initRes)')
    );
    expect(code).toContain('const factory = await initRes.loadShare(pkg');
    expect(code).not.toContain('import exposesMap from');
    expect(code).not.toContain('import {usedShared, usedRemotes} from');
  });

  it('loads the local shared map dynamically when a local eager share is configured', async () => {
    const mod = await import('../virtualRemoteEntry');
    const eagerShare = {
      name: 'eager-shared',
      version: '1.0.0',
      scope: 'default',
      from: '',
      shareConfig: { eager: true, import: undefined },
    };

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {},
        shared: { 'eager-shared': eagerShare },
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'build'
    );

    expect(code).toMatch(
      /retrySharedInit\(\(\) => import\("virtual:mf-localSharedImportMap:__mfe_internal__host__mf_owner__\d+"\)\)/
    );
    expect(code).not.toContain('__mfLocalSharedImportMap');
  });

  it('patches server-calc providers from Snapshot and coverage-caches runtime selections', async () => {
    const treeShare = {
      name: 'tree-shared',
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        singleton: false,
        requiredVersion: '^19.2.4',
        strictVersion: false,
        treeShaking: { mode: 'server-calc', usedExports: ['Button'] },
      },
    };
    normalizedSharedMock.mockReturnValue({ 'tree-shared': treeShare });
    const mod = await import('../virtualRemoteEntry');

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
      'build'
    );

    expect(code).toContain('getRemoteEntry');
    expect(code).toContain('global as runtimeGlobal');
    expect(code).toContain('name: "vite-tree-shaking-snapshot-plugin"');
    expect(code).toContain('secondarySharedTreeShakingEntry: entry');
    expect(code).toContain('treeShaking.mode !== "server-calc"');
    expect(code).toContain('if (status === 2 && (!entry || !name)) continue;');
    expect(code).toContain('type: fallbackType || "global"');
    expect(code).toContain('await shareEntry.init(origin);');
    expect(code).toContain('if (typeof fullFallbackGet === "function") return fullFallbackGet();');
    expect(code).toContain('__mfWriteTreeShakingSharedCache(');
    expect(code).toContain('treeShaking.providedExports');
    expect(code).toContain('if (!treeShaking) return;');
    expect(code).not.toContain('treeShaking.providedExports.length === 0) continue;');
    expect(code).toContain('const hasPartialProvider =');
    expect(code).toContain(
      'const providedExports = treeShaking.providedExports ?? treeShaking.usedExports ?? [];'
    );
    expect(code).not.toContain('treeShaking.providedExports.length > 0');
    expect(code).toContain('if (share.treeShaking || share.shareConfig?.import === false)');
    const materializedBridgeCall = code.indexOf(
      'await __mfBridgeMaterializedProvider(pkg, usedShare, initialShared[pkg]);'
    );
    const materializedPreSeedLoop = code.lastIndexOf(
      'for (const batch of __mfMaterializedShareBatches)',
      materializedBridgeCall
    );
    expect(code.slice(materializedPreSeedLoop, materializedBridgeCall)).toContain(
      'if (!usedShare || usedShare.materialize === false || usedShare.treeShaking) return;'
    );
    const aliasCacheLoop = code.indexOf(
      'for (const [pkg, share] of Object.entries(usedShared))',
      materializedBridgeCall
    );
    expect(code.slice(aliasCacheLoop, code.indexOf('const __mfSeedOrder ='))).toContain(
      'if (share.treeShaking) continue;'
    );
    expect(code).toContain(
      'plugins: [__mfSharePinLifecyclePlugin(), __mfRealNameSnapshotPlugin(), __mfTreeShakingSnapshotPlugin(),'
    );
  });

  it('coverage-caches runtime-infer partials even when provider coverage is empty', async () => {
    const treeShare = {
      name: 'tree-shared',
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        singleton: false,
        import: false,
        requiredVersion: '^19.2.4',
        strictVersion: false,
        treeShaking: { mode: 'runtime-infer', usedExports: [] },
      },
    };
    normalizedSharedMock.mockReturnValue({ 'tree-shared': treeShare });
    const mod = await import('../virtualRemoteEntry');

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
      'build'
    );
    const treeResolutionStart = code.indexOf('// Resolve tree-enabled shares through the Runtime');
    const treeResolutionEnd = code.indexOf(
      'const __mfResolveImportFalseShared =',
      treeResolutionStart
    );
    const treeResolutionCode = code.slice(treeResolutionStart, treeResolutionEnd);
    const genericWrite = vi.fn();
    const treeWrite = vi.fn();
    const selectionWrite = vi.fn();
    const partial = { Button: 'partial' };

    await new Function(
      'initRes',
      'usedShared',
      '__mfModuleCache',
      '__mfGetSharedCacheDescriptor',
      '__mfWriteSharedCache',
      '__mfWriteTreeShakingSharedCache',
      '__mfWriteTreeShakingSharedSelection',
      'mfName',
      `return (async () => {
        ${treeResolutionCode}
        await __mfResolveTreeShakingShared('tree-shared', usedShared['tree-shared']);
      })();`
    )(
      { loadShare: async () => () => partial },
      {
        'tree-shared': {
          ...treeShare,
          scope: ['default'],
          treeShaking: {
            mode: 'runtime-infer',
            status: 1,
            usedExports: [],
            providedExports: [],
          },
        },
      },
      { share: {} },
      () => ({ canonical: 'default:tree-shared@19.2.4' }),
      genericWrite,
      treeWrite,
      selectionWrite,
      'remote'
    );

    expect(genericWrite).not.toHaveBeenCalled();
    expect(treeWrite).toHaveBeenCalledWith(
      {},
      { canonical: 'default:tree-shared@19.2.4' },
      [],
      partial
    );
    expect(selectionWrite).toHaveBeenCalledWith(
      {},
      { canonical: 'default:tree-shared@19.2.4' },
      'remote',
      partial
    );
    const importFalseFallback = code.slice(treeResolutionEnd, code.indexOf('initResolve(initRes)'));
    expect(importFalseFallback).toContain('if (share.treeShaking) {');
    expect(importFalseFallback).toContain('__mfWriteTreeShakingSharedCache(');
    expect(importFalseFallback).toContain('__mfWriteTreeShakingSharedSelection(');
  });

  it('includes remote aliases in version-first remoteEntry initialization', async () => {
    normalizedRemotesMock.mockReturnValue({
      catalog: {
        entryGlobalName: 'catalog',
        name: 'catalogContainer',
        type: 'module',
        entry: 'http://localhost:4174/remoteEntry.js',
      },
    });
    usedRemotesMapMock.mockReturnValue({ catalog: new Set(['catalog/Button']) });
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateLocalSharedImportMap();

    expect(code).toContain('alias: "catalog"');
    expect(code).toContain('name: "catalogContainer"');
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

  it.each(['version-first', 'loaded-first'] as const)(
    'keeps a scoped %s build init when host auto init re-enters a dual-role container',
    async (shareStrategy) => {
      const mod = await import('../virtualRemoteEntry');
      const code = mod.generateRemoteEntry(
        {
          internalName: '__mfe_internal__mid',
          name: 'mid',
          filename: 'remoteEntry.js',
          exposes: { './probe': './probe.js' },
          remotes: {
            leaf: {
              name: 'leaf',
              entry: 'http://localhost:4173/remoteEntry.js',
              type: 'module',
            },
          },
          shared: {},
          runtimePlugins: [],
          shareScope: 'default',
          shareStrategy,
        } as any,
        'virtual:exposes',
        'build'
      );

      expect(code).toContain('if (shared === undefined && __mfInitPromise)');
      expect(code).toContain('export { __mfGuardedInit as init, getExposes as get }');
      const guardStart = code.indexOf('let __mfInitPromise;');
      const guardEnd = code.indexOf('export { __mfGuardedInit', guardStart);
      const guardCode = code.slice(guardStart, guardEnd);
      const scopedInit = Promise.resolve({ shareScopeMap: { default: {} } });
      const init = vi.fn(() => scopedInit);
      const guardedInit = new Function('init', `${guardCode}; return __mfGuardedInit;`)(init);

      expect(guardedInit({ react: {} }, [])).toBe(scopedInit);
      expect(guardedInit()).toBe(scopedInit);
      expect(init).toHaveBeenCalledOnce();
      expect(guardCode).not.toContain('await ');
    }
  );

  it('does not preload generated subpath shares from a root shared package', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('lit/decorators.js');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(code).toContain('const __mfHostInitShareBatches');
    expect(code).toContain('"lit/decorators.js"');
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
    expect(code).toContain('for (const __mfHostInitShareBatch of __mfHostInitShareBatches)');
  });

  it('preloads independent shared packages in parallel during host auto init', async () => {
    const share = (name: string) => ({
      name,
      from: '',
      version: '1.0.0',
      scope: 'default',
      shareConfig: { singleton: true, requiredVersion: '^1.0.0', strictVersion: false },
    });
    normalizedSharedMock.mockReturnValue({
      'pkg-a': share('pkg-a'),
      'pkg-b': share('pkg-b'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('pkg-a');
    mod.addUsedShares('pkg-b');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    const batchesMarker = 'const __mfHostInitShareBatches = ';
    const batchesStart = code.indexOf(batchesMarker);
    expect(batchesStart).not.toBe(-1);
    const loopEnd = code.indexOf('return runtime;', batchesStart);
    const loopCode = code.slice(batchesStart, loopEnd);

    // pkg-a and pkg-b have no dependency relationship, so they must sit in
    // the same batch and load concurrently instead of one after another.
    expect(loopCode).toContain('await Promise.all(');

    const order: string[] = [];
    const resolvers: Record<string, (factory: () => unknown) => void> = {};
    const runtime = {
      loadShare: (pkg: string) => {
        order.push(`start:${pkg}`);
        return new Promise((resolve) => {
          resolvers[pkg] = resolve;
        }).then((factory) => {
          order.push(`end:${pkg}`);
          return factory;
        });
      },
    };

    const run = new Function(
      'usedShared',
      'runtime',
      '__mfModuleCache',
      '__mfGetSharedCacheDescriptor',
      '__mfReadSharedCache',
      '__mfReadSharedCacheOwner',
      '__mfWriteSharedCache',
      '__mfNormalizeRuntimeShare',
      `return (async () => { ${loopCode} })();`
    );

    const donePromise = run(
      { 'pkg-a': share('pkg-a'), 'pkg-b': share('pkg-b') },
      runtime,
      { share: {} },
      (pkg: string) => ({ canonical: pkg }),
      () => undefined,
      () => undefined,
      () => {},
      (m: unknown) => m
    );

    // Let both loadShare calls start before resolving either.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start:pkg-a', 'start:pkg-b']);

    resolvers['pkg-a'](() => ({}));
    resolvers['pkg-b'](() => ({}));
    await donePromise;

    expect(order).toEqual(['start:pkg-a', 'start:pkg-b', 'end:pkg-a', 'end:pkg-b']);
  });

  it('seeds package subpath shares and shared dependencies before their consumers', async () => {
    const shareItem = (name: string) => ({
      name,
      from: '',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/core': shareItem('@repro/core'),
      '@repro/shared-lib': shareItem('@repro/shared-lib'),
      '@repro/shared-lib/media': shareItem('@repro/shared-lib/media'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/core');
    mod.addUsedShares('@repro/shared-lib');
    mod.addUsedShares('@repro/shared-lib/media');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
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

    const seedOrderMatch = code.match(/const __mfSeedOrder = (\[[^\]]*\]);/);
    expect(seedOrderMatch).not.toBeNull();
    const seedOrder = JSON.parse(seedOrderMatch![1]) as string[];

    // A package's modules can consume its own shared subpath exports through
    // self-referencing bare specifiers at module-evaluation time, so the
    // subpath must be cached before the package root is evaluated.
    expect(seedOrder.indexOf('@repro/shared-lib/media')).toBeLessThan(
      seedOrder.indexOf('@repro/shared-lib')
    );
    // Shared dependencies seed before their consumers (@repro/core depends
    // on @repro/shared-lib).
    expect(seedOrder.indexOf('@repro/shared-lib')).toBeLessThan(seedOrder.indexOf('@repro/core'));
    expect(code).toContain('const __mfSeedKeys = __mfSeedOrder.filter');
    expect(code).toContain('for (const batch of __mfSeedBatches) await Promise.all');
    expect(code).toContain('const providerKey = cacheDescriptor.canonical;');
  });

  it('defers consumers of tree-enabled shares until the tree selection is cached', async () => {
    const shareItem = (name: string, treeShaking = false) => ({
      name,
      from: '',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        ...(treeShaking
          ? { treeShaking: { mode: 'runtime-infer' as const, usedExports: ['value'] } }
          : {}),
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/core': shareItem('@repro/core'),
      '@repro/shared-lib': shareItem('@repro/shared-lib', true),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/core');
    mod.addUsedShares('@repro/shared-lib');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
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
    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const calls: string[] = [];
    const state = { treeReady: false };
    const usedShared = {
      '@repro/shared-lib': {
        name: '@repro/shared-lib',
        version: '1.0.0',
        scope: ['default'],
        shareConfig: { singleton: true },
        treeShaking: { mode: 'runtime-infer', status: 1, usedExports: ['value'] },
        get: async () => {
          throw new Error('tree share must be resolved by the Runtime');
        },
      },
      '@repro/core': {
        name: '@repro/core',
        version: '1.0.0',
        scope: ['default'],
        shareConfig: { singleton: true },
        get: async () => {
          if (!state.treeReady) throw new Error('tree dependency was not ready');
          calls.push('@repro/core');
          return () => ({ value: 'core' });
        },
      },
    };

    await new Function(
      'usedShared',
      'state',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const mfName = 'host';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          const id = singleton || !version ? pkg : pkg + '@' + version;
          return { canonical: scopeName + ':' + id };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const treeSelections = Object.create(null);
        const __mfReadTreeShakingSharedSelection = (_cache, descriptor, consumer) =>
          treeSelections[descriptor.canonical + ':' + consumer];
        const __mfResolveTreeShakingShared = async () => {
          throw new Error('ready tree share should not resolve again');
        };
        const __mfResolveImportFalseShared = async () => {};
        ${seedCode}
        state.treeReady = true;
        treeSelections['default:@repro/shared-lib:host'] = { value: 'tree' };
        ${deferredResolutionCode}
      })();`
    )(usedShared, state);

    expect(calls).toEqual(['@repro/core']);
  });

  it('seeds tree dependents when a complete provider is in the generic cache', async () => {
    const shareItem = (name: string, treeShaking = false) => ({
      name,
      from: 'remote',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        ...(treeShaking
          ? { treeShaking: { mode: 'runtime-infer' as const, usedExports: ['value'] } }
          : {}),
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/core': shareItem('@repro/core'),
      '@repro/shared-lib': shareItem('@repro/shared-lib', true),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/core');
    mod.addUsedShares('@repro/shared-lib');

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
    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const state = { consumerLoads: 0, treeResolutions: 0 };
    const usedShared = {
      '@repro/shared-lib': {
        ...shareItem('@repro/shared-lib', true),
        scope: ['default'],
        treeShaking: { mode: 'runtime-infer', status: 0, usedExports: ['value'] },
        get: async () => {
          throw new Error('complete tree provider should already be cached');
        },
      },
      '@repro/core': {
        ...shareItem('@repro/core'),
        scope: ['default'],
        get: async () => {
          state.consumerLoads++;
          return () => ({ value: 'core' });
        },
      },
    };

    await new Function(
      'usedShared',
      'state',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const mfName = 'remote';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          const id = singleton || !version ? pkg : pkg + '@' + version;
          return { canonical: scopeName + ':' + id };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = () => undefined;
        const __mfResolveTreeShakingShared = async () => {
          state.treeResolutions++;
        };
        const __mfResolveImportFalseShared = async () => {};
        ${seedCode}
        __mfModuleCache.share['default:@repro/shared-lib'] = { value: 'complete-tree' };
        ${deferredResolutionCode}
      })();`
    )(usedShared, state);

    expect(state.treeResolutions).toBe(0);
    expect(state.consumerLoads).toBe(1);
  });

  it('resolves import:false dependencies before tree providers that consume them', async () => {
    const shareItem = (name: string, options: { importFalse?: boolean; tree?: boolean } = {}) => ({
      name,
      from: 'remote',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        ...(options.importFalse ? { import: false } : {}),
        ...(options.tree
          ? { treeShaking: { mode: 'runtime-infer' as const, usedExports: ['value'] } }
          : {}),
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/core': shareItem('@repro/core', { tree: true }),
      '@repro/shared-lib': shareItem('@repro/shared-lib', { importFalse: true }),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/core');
    mod.addUsedShares('@repro/shared-lib');

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
    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const order: string[] = [];
    const usedShared = {
      '@repro/shared-lib': {
        ...shareItem('@repro/shared-lib', { importFalse: true }),
        scope: ['default'],
      },
      '@repro/core': {
        ...shareItem('@repro/core', { tree: true }),
        scope: ['default'],
        treeShaking: { mode: 'runtime-infer', status: 1, usedExports: ['value'] },
      },
    };

    await new Function(
      'usedShared',
      'order',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const treeSelections = Object.create(null);
        const mfName = 'remote';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          const id = singleton || !version ? pkg : pkg + '@' + version;
          return { canonical: scopeName + ':' + id };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = (_cache, descriptor, consumer) =>
          treeSelections[descriptor.canonical + ':' + consumer];
        const __mfResolveImportFalseShared = async (pkg) => {
          order.push(pkg);
          __mfModuleCache.share['default:' + pkg] = { value: 'host-only' };
        };
        const __mfResolveTreeShakingShared = async (pkg) => {
          if (!__mfModuleCache.share['default:@repro/shared-lib']) {
            throw new Error('tree provider evaluated before its import:false dependency');
          }
          order.push(pkg);
          treeSelections['default:' + pkg + ':remote'] = { value: 'partial-tree' };
        };
        ${seedCode}
        ${deferredResolutionCode}
      })();`
    )(usedShared, order);

    expect(order).toEqual(['@repro/shared-lib', '@repro/core']);
  });

  it('resolves an import:false share during init even before the dev scanner has materialized it (#1090)', async () => {
    // Dev-only cold start: a cross-origin host requests remoteEntry.js before Vite's
    // resolveId has ever processed the exposed module's own import of the share, so
    // the share is configured but not yet materialized when this remoteEntry.js is
    // generated. Because import:false shares have no local fallback, init() must
    // still attempt to resolve them — otherwise the share is never seeded, and the
    // exposed module reads its still-undefined export at evaluation time.
    const shareItem = (name: string) => ({
      name,
      from: 'remote',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        import: false as const,
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/host-only': shareItem('@repro/host-only'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addConfiguredShare('@repro/host-only');

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

    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const resolved: string[] = [];
    const usedShared = {
      '@repro/host-only': {
        ...shareItem('@repro/host-only'),
        scope: ['default'],
        materialize: false,
      },
    };

    await new Function(
      'usedShared',
      'resolved',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const mfName = 'remote';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          return { canonical: scopeName + ':' + (singleton || !version ? pkg : pkg + '@' + version) };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = () => undefined;
        const __mfResolveTreeShakingShared = async () => {};
        const __mfResolveImportFalseShared = async (pkg) => {
          resolved.push(pkg);
          __mfModuleCache.share['default:' + pkg] = { value: 'host-provided' };
        };
        ${seedCode}
        ${deferredResolutionCode}
      })();`
    )(usedShared, resolved);

    expect(resolved).toEqual(['@repro/host-only']);
  });

  it('does not reject init when a runtime-only provider fails to load', async () => {
    const shareItem = (name: string) => ({
      name,
      from: 'remote',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        import: false as const,
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/failing': shareItem('@repro/failing'),
      '@repro/other': shareItem('@repro/other'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/failing');
    mod.addUsedShares('@repro/other');

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
    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const attempted: string[] = [];
    const usedShared = {
      '@repro/failing': { ...shareItem('@repro/failing'), scope: ['default'] },
      '@repro/other': { ...shareItem('@repro/other'), scope: ['default'] },
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A provider whose chunk fails to load must not escalate to a container-wide failure.
      await expect(
        new Function(
          'usedShared',
          'attempted',
          `return (async () => {
            const __mfModuleCache = { share: {} };
            const mfName = 'remote';
            const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
              const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
              return { canonical: scopeName + ':' + (singleton || !version ? pkg : pkg + '@' + version) };
            };
            const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
            const __mfReadSharedCacheOwner = () => undefined;
            const __mfWriteSharedCache = (cache, descriptor, value) => {
              cache[descriptor.canonical] = value;
            };
            const __mfReadTreeShakingSharedSelection = () => undefined;
            const __mfResolveImportFalseShared = async (pkg) => {
              attempted.push(pkg);
              throw Object.assign(new Error('Loading chunk 1 failed.'), { name: 'ChunkLoadError' });
            };
            const __mfResolveTreeShakingShared = async () => {};
            ${seedCode}
            ${deferredResolutionCode}
          })();`
        )(usedShared, attempted)
      ).resolves.not.toThrow();

      // The failure blocks only the failing share; the unrelated one is still attempted.
      expect(attempted).toEqual(['@repro/failing', '@repro/other']);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to resolve runtime-only shared module "@repro/failing"'),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('seeds shares that do not depend on an unresolved runtime-only share', async () => {
    const shareItem = (name: string, importFalse = false) => ({
      name,
      from: 'remote',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        ...(importFalse ? { import: false as const } : {}),
      },
    });
    // `@repro/core` depends on `@repro/shared-lib` (see the packageUtils mock); `@repro/react-consumer` does not.
    normalizedSharedMock.mockReturnValue({
      '@repro/shared-lib': shareItem('@repro/shared-lib', true),
      '@repro/core': shareItem('@repro/core'),
      '@repro/react-consumer': shareItem('@repro/react-consumer'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/shared-lib');
    mod.addUsedShares('@repro/core');
    mod.addUsedShares('@repro/react-consumer');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: normalizedSharedMock(),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'loaded-first',
      } as any,
      'virtual:exposes',
      'build'
    );
    expect(code).toContain('const __mfSeedPrerequisites = ');
    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const attempted: string[] = [];
    const localShare = (name: string) => ({
      ...shareItem(name),
      scope: ['default'],
      get: async () => () => ({ value: name }),
    });
    const usedShared = {
      '@repro/shared-lib': { ...shareItem('@repro/shared-lib', true), scope: ['default'] },
      '@repro/core': localShare('@repro/core'),
      '@repro/react-consumer': localShare('@repro/react-consumer'),
    };

    const cache = await new Function(
      'usedShared',
      'attempted',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const mfName = 'host';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          return { canonical: scopeName + ':' + (singleton || !version ? pkg : pkg + '@' + version) };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = () => undefined;
        const __mfResolveTreeShakingShared = async () => {};
        // No provider ever registers the host-only share: it stays pending.
        const __mfResolveImportFalseShared = async (pkg) => {
          attempted.push(pkg);
        };
        ${seedCode}
        ${deferredResolutionCode}
        return __mfModuleCache.share;
      })();`
    )(usedShared, attempted);

    expect(attempted).toEqual(['@repro/shared-lib']);
    // The independent share is seeded; the unresolved share and its dependent are not.
    expect(cache['default:@repro/react-consumer']).toEqual({ value: '@repro/react-consumer' });
    expect(cache['default:@repro/core']).toBeUndefined();
    expect(cache['default:@repro/shared-lib']).toBeUndefined();
  });

  it('does not seed a cycle member before its unresolved runtime-only prerequisite', async () => {
    const shareItem = (name: string, importFalse = false) => ({
      name,
      from: 'remote',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
        ...(importFalse ? { import: false as const } : {}),
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/aaa-host-only': shareItem('@repro/aaa-host-only', true),
      '@repro/zzz-consumer': shareItem('@repro/zzz-consumer'),
    });
    const mod = await import('../virtualRemoteEntry');
    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/aaa-host-only');
    mod.addUsedShares('@repro/zzz-consumer');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: normalizedSharedMock(),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'loaded-first',
      } as any,
      'virtual:exposes',
      'build'
    );
    const attempted: string[] = [];
    const usedShared = {
      '@repro/aaa-host-only': {
        ...shareItem('@repro/aaa-host-only', true),
        scope: ['default'],
      },
      '@repro/zzz-consumer': {
        ...shareItem('@repro/zzz-consumer'),
        scope: ['default'],
        get: async () => () => ({ value: 'must stay blocked' }),
      },
    };

    const cache = await new Function(
      'usedShared',
      'attempted',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const mfName = 'host';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => ({
          canonical: (Array.isArray(scope) ? scope[0] : scope || 'default') + ':' + pkg
        });
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = () => undefined;
        const __mfResolveTreeShakingShared = async () => {};
        const __mfResolveImportFalseShared = async (pkg) => attempted.push(pkg);
        ${getRuntimeSeedCode(code)}
        ${getRuntimeDeferredResolutionCode(code)}
        return __mfModuleCache.share;
      })();`
    )(usedShared, attempted);

    expect(attempted).toEqual(['@repro/aaa-host-only']);
    expect(cache['default:@repro/aaa-host-only']).toBeUndefined();
    expect(cache['default:@repro/zzz-consumer']).toBeUndefined();
  });

  it('bridges a lazy singleton before evaluating shared modules that capture it', async () => {
    const shareItem = (name: string) => ({
      name,
      from: 'remote',
      version: '18.3.1',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^18.0.0',
        strictVersion: false,
      },
    });
    normalizedSharedMock.mockReturnValue({
      react: shareItem('react'),
      'react-dom': shareItem('react-dom'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');
    mod.addUsedShares('react-dom');

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
    const seedCode = getRuntimeSeedCode(code);
    const deferredResolutionCode = getRuntimeDeferredResolutionCode(code);
    const state: {
      cache?: Record<string, unknown>;
      capturedReact?: unknown;
      localReactLoads: number;
    } = {
      localReactLoads: 0,
    };
    const hostReact = { marker: 'host-react' };
    const usedShared = {
      react: {
        ...shareItem('react'),
        scope: ['default'],
        get: async () => {
          state.localReactLoads++;
          return () => ({ marker: 'local-react' });
        },
      },
      'react-dom': {
        ...shareItem('react-dom'),
        scope: ['default'],
        get: async () => {
          state.capturedReact = state.cache?.['default:react'];
          return () => ({ marker: 'react-dom' });
        },
      },
    };

    await new Function(
      'usedShared',
      'state',
      'hostReact',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        state.cache = __mfModuleCache.share;
        const mfName = 'remote';
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          const id = singleton || !version ? pkg : pkg + '@' + version;
          return { canonical: scopeName + ':' + id };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = () => undefined;
        const __mfResolveTreeShakingShared = async () => {};
        const __mfResolveImportFalseShared = async () => {};
        const initialShared = {
          react: { '18.3.1': { from: 'host' } },
          'react-dom': { '18.3.1': { from: 'host' } },
        };
        const runtimeResolveShareHook = {};
        const __mfSelectExternalSharedProvider = (versions) =>
          versions && Object.values(versions)[0];
        ${seedCode}
        if (state.localReactLoads !== 0 || state.capturedReact !== undefined) {
          throw new Error('shared modules evaluated before Runtime selection');
        }
        __mfModuleCache.share['default:react'] = hostReact;
        ${deferredResolutionCode}
      })();`
    )(usedShared, state, hostReact);

    expect(state.localReactLoads).toBe(0);
    expect(state.capturedReact).toBe(hostReact);
    const globalBridgeEnd = code.indexOf(
      "console.error('[Module Federation] Failed to bridge external shared modules'"
    );
    const orderedRuntimeSeed = code.indexOf(
      'for (const pkg of __mfDeferredSeedKeys)',
      globalBridgeEnd
    );
    expect(orderedRuntimeSeed).toBeGreaterThan(globalBridgeEnd);
  });

  it('seeds a root host singleton before version-first remote initialization', async () => {
    const hostReactShare = {
      name: 'react',
      from: 'host',
      version: '18.3.1',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^18.0.0',
        strictVersion: false,
      },
    };
    normalizedSharedMock.mockReturnValue({ react: hostReactShare });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

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
        shared: normalizedSharedMock(),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );
    const seedCode = getRuntimeSeedCode(code);
    const state = { localReactLoads: 0, cachedReact: undefined as unknown };
    const usedShared = {
      react: {
        ...hostReactShare,
        scope: ['default'],
        get: async () => {
          state.localReactLoads++;
          return () => ({ marker: 'host-react' });
        },
      },
    };

    await new Function(
      'usedShared',
      'state',
      `return (async () => {
        const __mfModuleCache = { share: {} };
        const mfName = 'host';
        const initialShared = {};
        const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
          const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
          const id = singleton || !version ? pkg : pkg + '@' + version;
          return { canonical: scopeName + ':' + id };
        };
        const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
        const __mfReadSharedCacheOwner = () => undefined;
        const __mfWriteSharedCache = (cache, descriptor, value) => {
          cache[descriptor.canonical] = value;
        };
        const __mfReadTreeShakingSharedSelection = () => undefined;
        const runtimeResolveShareHook = {};
        const __mfSelectExternalSharedProvider = () => undefined;
        ${seedCode}
        state.cachedReact = __mfModuleCache.share['default:react'];
      })();`
    )(usedShared, state);

    expect(state.localReactLoads).toBe(1);
    expect(state.cachedReact).toMatchObject({ marker: 'host-react' });
  });

  it('orders package subpath shares discovered after remoteEntry codegen before their package root', async () => {
    const shareItem = (name: string) => ({
      name,
      from: '',
      version: '1.0.0',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^1.0.0',
        strictVersion: false,
      },
    });
    normalizedSharedMock.mockReturnValue({
      '@repro/shared-lib': shareItem('@repro/shared-lib'),
    });
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('@repro/shared-lib');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__host',
        name: 'host',
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

    const seedOrderMatch = code.match(/const __mfSeedOrder = (\[[^\]]*\]);/);
    expect(seedOrderMatch).not.toBeNull();
    expect(JSON.parse(seedOrderMatch![1]) as string[]).toEqual(['@repro/shared-lib']);

    const seedCode = getRuntimeSeedCode(code);
    const calls: string[] = [];
    const usedShared = {
      '@repro/shared-lib': {
        name: '@repro/shared-lib',
        version: '1.0.0',
        scope: ['default'],
        shareConfig: { singleton: true },
        get: async () => {
          calls.push('@repro/shared-lib');
          return () => ({});
        },
      },
      '@repro/shared-lib/media': {
        name: '@repro/shared-lib/media',
        version: '1.0.0',
        scope: ['default'],
        shareConfig: { singleton: true },
        get: async () => {
          calls.push('@repro/shared-lib/media');
          return () => ({});
        },
      },
    };

    await new Function(
      'usedShared',
      `
        return (async () => {
          const __mfModuleCache = { share: {} };
          const mfName = 'host';
          const __mfGetSharedCacheDescriptor = (pkg, singleton, version, scope) => {
            const scopeName = Array.isArray(scope) ? scope[0] : scope || 'default';
            const id = singleton || !version ? pkg : pkg + '@' + version;
            return { canonical: scopeName + ':' + id };
          };
          const __mfReadSharedCache = (cache, descriptor) => cache[descriptor.canonical];
          const __mfReadSharedCacheOwner = () => undefined;
          const __mfWriteSharedCache = (cache, descriptor, value, owner) => {
            cache[descriptor.canonical] = value;
          };
          ${seedCode}
          await __mfSeedLocalShared(__mfDeferredSeedKeys);
        })();
      `
    )(usedShared);

    expect(calls.indexOf('@repro/shared-lib/media')).toBeLessThan(
      calls.indexOf('@repro/shared-lib')
    );
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
    expect(code).not.toContain('const deferredRemotes =');
    expect(code).not.toContain('initRes.options.remotes.push(...deferredRemotes);');
    const materializedBridgeCode = code.slice(
      code.indexOf('const __mfBridgeMaterializedProvider ='),
      code.indexOf('const __mfBridgeExternalSharedProvider =')
    );
    expect(materializedBridgeCode).toContain(
      "if (singleton && 'loaded-first' !== 'loaded-first') return;"
    );
    expect(materializedBridgeCode).toContain('if (usedShare.canLiveRebind === false) return;');
  });

  it("never bridges onto another container's consume-only stub", async () => {
    optionsMock.shareStrategy = 'loaded-first';
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__provider',
        name: 'provider',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: {},
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'loaded-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    // A host's `import: false` share registers a scope entry whose get() throws "must be provided by
    // host". Selected as the same-version provider (first registrant wins), it must be skipped before
    // its get() runs, in both bridge passes — otherwise every provider init logs "Failed to bridge".
    const guard = 'if (provider?.shareConfig?.import === false) return;';
    const materializedBridgeCode = code.slice(
      code.indexOf('const __mfBridgeMaterializedProvider ='),
      code.indexOf('const __mfBridgeExternalSharedProvider =')
    );
    const externalBridgeCode = code.slice(
      code.indexOf('const __mfBridgeExternalSharedProvider ='),
      code.indexOf('for (const batch of __mfMaterializedShareBatches) await Promise.all(')
    );
    expect(materializedBridgeCode).toContain(guard);
    expect(materializedBridgeCode.indexOf(guard)).toBeLessThan(
      materializedBridgeCode.indexOf('const { version } = providerEntry;')
    );
    expect(externalBridgeCode).toContain(guard);
    expect(externalBridgeCode.indexOf(guard)).toBeLessThan(
      externalBridgeCode.indexOf('await __mfLoadPinnedRuntimeShare(')
    );
  });

  it('keeps the remote registry intact while pre-seeding version-first shares', async () => {
    optionsMock.shareStrategy = 'version-first';
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
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    const runtimeInitCall = code.indexOf('const initRes = runtimeInit({');
    const initShareScopeMapCall = code.indexOf("__mfGetRuntimeShareScope('default', shared)");
    const materializedBridgeCall = code.indexOf(
      'await __mfBridgeMaterializedProvider(pkg, usedShare, initialShared[pkg]);'
    );
    const initializeSharingCall = code.indexOf(
      `await Promise.all(await initRes.initializeSharing('default'`
    );

    expect(code).toContain('remotes: usedRemotes');
    expect(runtimeInitCall).toBeGreaterThan(-1);
    expect(initShareScopeMapCall).toBeGreaterThan(runtimeInitCall);
    expect(materializedBridgeCall).toBeGreaterThan(initShareScopeMapCall);
    expect(initializeSharingCall).toBeGreaterThan(materializedBridgeCall);
    expect(code).not.toContain('initRes.options.remotes.splice(0)');
    expect(code).not.toContain('initRes.options.remotes.push(...deferredRemotes)');
  });

  it('pre-seeds a loaded-first default-only singleton before local proxy evaluation', async () => {
    optionsMock.shareStrategy = 'loaded-first';
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('default-only-singleton');

    const localSharedCode = mod.generateLocalSharedImportMap();
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
        shareStrategy: 'loaded-first',
      } as any,
      'virtual:exposes',
      'serve'
    );
    const materializedBridgeCode = code.slice(
      code.indexOf('const __mfBridgeMaterializedProvider ='),
      code.indexOf('const __mfBridgeExternalSharedProvider =')
    );
    const lateBridgeCode = code.slice(
      code.indexOf('const __mfBridgeExternalSharedProvider ='),
      code.indexOf('for (const [pkg, usedShare] of Object.entries(usedShared))')
    );

    expect(localSharedCode).toContain('canLiveRebind: true');
    expect(materializedBridgeCode).toContain('if (usedShare.canLiveRebind === false) return;');
    expect(lateBridgeCode).toContain('if (usedShare.canLiveRebind === false) return;');
  });

  it('late-bridges a version-first default-only singleton after runtime selection', async () => {
    optionsMock.shareStrategy = 'version-first';
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('default-only-singleton');

    const localSharedCode = mod.generateLocalSharedImportMap();
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
    const materializedBridgeCode = code.slice(
      code.indexOf('const __mfBridgeMaterializedProvider ='),
      code.indexOf('const __mfBridgeExternalSharedProvider =')
    );
    const initializeSharingCall = code.indexOf(
      `await Promise.all(await initRes.initializeSharing('default'`
    );
    const lateBridgeCall = code.indexOf(
      'await __mfBridgeExternalSharedProvider(',
      initializeSharingCall
    );

    expect(localSharedCode).toContain('canLiveRebind: true');
    expect(materializedBridgeCode).toContain(
      "if (singleton && 'version-first' !== 'loaded-first') return;"
    );
    expect(initializeSharingCall).toBeGreaterThan(-1);
    expect(lateBridgeCall).toBeGreaterThan(initializeSharingCall);
    expect(code).toContain('let __mfLateBridgeShared');
    expect(code).toContain('const __mfBridgeSharedProviders = async () =>');
    expect(code).toContain('if (__mfUsesWebpackShareScope) {');
    expect(code).toContain('__mfLateBridgeShared = __mfBridgeSharedProviders');
    expect(code).toContain('if (__mfLateBridgeShared) await __mfLateBridgeShared()');
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

  it('refreshes external shares while preserving the host-owned cache in builds', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(code).toContain('const __mfGetSharedCacheDescriptor =');
    expect(code).toContain(
      '__mfReadSharedCacheOwner(__mfModuleCache.share, cacheDescriptor) === "host"'
    );
    expect(code).not.toContain(
      '__mfReadSharedCacheOwner(__mfModuleCache.share, cacheDescriptor) !== undefined'
    );
    expect(code).toMatch(
      /__mfWriteSharedCache\(\s*__mfModuleCache\.share,\s*cacheDescriptor,\s*resolved,\s*"host"\s*\)/
    );
    expect(code).not.toContain('__mfModuleCache.share[cacheKey]');
  });

  it('preserves an owned host share cache during dev', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('react');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'serve');

    expect(code).toContain(
      '__mfReadSharedCacheOwner(__mfModuleCache.share, cacheDescriptor) !== undefined'
    );
  });

  it('bridges materialized shares without losing singleton cache semantics', async () => {
    normalizedSharedMock.mockReturnValue({
      react: {
        name: 'react',
        from: '',
        version: '18.3.1',
        scope: 'default',
        shareConfig: {
          singleton: true,
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
    expect(code).toContain('const initialShared = Object.create(null);');
    expect(code).toContain('const initialVersions = initialShared[pkg] = Object.create(null);');
    expect(code).toContain('for (const [version, provider] of Object.entries(versions))');
    expect(code).toContain('initialVersions[version] = Object.assign({}, provider);');
    expect(code).not.toContain(
      'initialShared[pkg] = Object.assign(Object.create(null), versions);'
    );
    expect(code.indexOf('const initialShared =')).toBeLessThan(
      code.indexOf('await getLocalSharedImportMap()')
    );
    expect(code).toContain(
      'const federationInstances = globalThis.__FEDERATION__?.__INSTANCES__ || [];'
    );
    expect(code).toContain('const initRootName = initScope.find((token) => token?.from)?.from;');
    expect(code).toContain('const scopeRoot = federationInstances.find');
    expect(code).toContain("instance?.shareScopeMap?.['default'] === shared");
    expect(code).toContain('const usedCacheDescriptor = __mfGetSharedCacheDescriptor');
    expect(code).toContain(
      '__mfWriteSharedCache(\n          __mfModuleCache.share,\n          usedCacheDescriptor,\n          normalized,\n          actualSelection.from'
    );
    const preSeedBridgeCode = code.slice(
      code.indexOf('const __mfBridgeMaterializedProvider ='),
      code.indexOf('const __mfBridgeExternalSharedProvider =')
    );
    expect(preSeedBridgeCode).toContain(
      "if (singleton && 'version-first' !== 'loaded-first') return;"
    );
    expect(preSeedBridgeCode).toContain('if (usedShare.canLiveRebind === false) return;');
    expect(preSeedBridgeCode).toContain('const provider = __mfSelectExternalSharedProvider(');
    expect(preSeedBridgeCode).toContain(
      'if (usedShare.shareConfig?.import === false && __mfMatchesSharedProvider(provider, usedShare)) return;'
    );
    expect(preSeedBridgeCode.indexOf('shareConfig?.import === false')).toBeLessThan(
      preSeedBridgeCode.indexOf('directFactory = await provider.get()')
    );
    expect(preSeedBridgeCode).toContain('if (!singleton && version !== usedShare.version) return;');
    expect(preSeedBridgeCode).toContain("!(provider.loaded && typeof provider.get === 'function')");
    expect(preSeedBridgeCode).toContain('directFactory = await provider.get();');
    expect(preSeedBridgeCode).toMatch(
      /__mfGetSharedCacheDescriptor\(\s*pkg,\s*singleton,\s*usedShare\.version/
    );
    expect(preSeedBridgeCode).not.toContain('runtimeResolveShareHook');
    expect(preSeedBridgeCode).not.toContain('__mfLoadPinnedRuntimeShare(');
    expect(preSeedBridgeCode).toContain(
      'if (providerEntry.registered && !__mfMatchesSharedProvider(liveProvider, provider)) return;'
    );
    expect(preSeedBridgeCode).toContain('const actualSelection = loadedShare?.selection;');
    expect(preSeedBridgeCode).toContain('if (!actualSelection) return;');
    expect(preSeedBridgeCode).not.toContain(
      '__mfMatchesSharedProvider({ from: actualSelection?.from }, provider)'
    );
    expect(preSeedBridgeCode).toContain('providerEntry.registered &&');
    expect(preSeedBridgeCode).toContain(
      'liveVersionMap?.[actualSelection.version] !== actualProvider'
    );
    expect(preSeedBridgeCode).toContain(
      '__mfWriteSharedCache(\n          __mfModuleCache.share,\n          usedCacheDescriptor,'
    );
    const preSeedBridgeCall = code.indexOf(
      'await __mfBridgeMaterializedProvider(pkg, usedShare, initialShared[pkg]);'
    );
    expect(preSeedBridgeCall).toBeGreaterThan(-1);
    expect(preSeedBridgeCall).toBeLessThan(code.indexOf('const __mfSeedOrder ='));
    const bridgeHelperCode = code.slice(
      code.indexOf('const __mfBridgeExternalSharedProvider ='),
      code.indexOf('for (const batch of __mfMaterializedShareBatches)')
    );
    expect(code).toContain('const bridgeSelections = new Map();');
    expect(bridgeHelperCode).toContain('passedVersionMap,');
    expect(bridgeHelperCode).toContain(
      'const selectedExternalProvider = __mfSelectExternalSharedProvider'
    );
    expect(bridgeHelperCode).toContain(
      'const selectedRuntimeProvider = selectedExternalProvider ||'
    );
    expect(bridgeHelperCode).toContain(
      "__mfSelectSharedProvider(versionMap, pkg, usedShare, 'version-first') ||\n          usedShare"
    );
    expect(bridgeHelperCode).toContain(
      "__mfSelectSharedProvider(versionMap, pkg, usedShare, 'version-first')"
    );
    expect(bridgeHelperCode).toContain('const passedProvider = passedVersionMap?.[version];');
    expect(bridgeHelperCode).not.toContain('runtimeResolveShareHook');
    expect(bridgeHelperCode).not.toContain('externalProviderSelection');
    expect(bridgeHelperCode).toContain(
      'const resolvedExternalProvider = __mfResolveExternalSharedProvider('
    );
    expect(bridgeHelperCode).toContain(
      'const { provider, scopeRootProvider } = resolvedExternalProvider || {'
    );
    expect(bridgeHelperCode).toContain('providerEntry.registered &&');
    expect(bridgeHelperCode).toContain('!__mfMatchesSharedProvider(liveProvider, provider)');
    expect(bridgeHelperCode).toContain(
      'if (!resolvedExternalProvider && !selectedLocalProvider) return;'
    );
    expect(bridgeHelperCode).toContain(
      'if (__mfMatchesSharedProvider(actualProvider, usedShare)) return;'
    );
    expect(bridgeHelperCode).toContain('bridgeSelections.set(pkg, {');
    expect(bridgeHelperCode).toContain('const loadedShare = await __mfLoadPinnedRuntimeShare(');
    expect(bridgeHelperCode).toContain('if (!actualSelection) return;');
    expect(bridgeHelperCode).not.toContain(
      '__mfMatchesSharedProvider({ from: actualSelection?.from }, provider)'
    );
    expect(bridgeHelperCode).toContain(
      'const cachedShareOwner = __mfReadSharedCacheOwner(__mfModuleCache.share, usedCacheDescriptor);'
    );
    expect(bridgeHelperCode).toContain(
      'if (cachedShare !== undefined && cachedShareOwner !== mfName) return;'
    );
    expect(bridgeHelperCode).toContain(
      'const latestCachedShareOwner = __mfReadSharedCacheOwner(__mfModuleCache.share, usedCacheDescriptor);'
    );
    expect(bridgeHelperCode).toContain(
      'if (latestCachedShare !== undefined && latestCachedShareOwner !== mfName) return;'
    );
    expect(bridgeHelperCode).toContain(
      'actualSelection.registered &&\n          liveVersionMap?.[actualSelection.version] !== actualProvider'
    );
    const liveProviderRead = bridgeHelperCode.indexOf(
      'const liveProvider = liveVersionMap?.[version]'
    );
    const providerLoad = bridgeHelperCode.indexOf(
      'const loadedShare = await __mfLoadPinnedRuntimeShare('
    );
    const latestOwnerRead = bridgeHelperCode.indexOf('const latestCachedShareOwner =');
    const bridgedCacheWrite = bridgeHelperCode.indexOf(
      '__mfWriteSharedCache(\n          __mfModuleCache.share,\n          usedCacheDescriptor,\n          normalized,\n          actualSelection.from'
    );
    expect(providerLoad).toBeGreaterThan(-1);
    expect(liveProviderRead).toBeLessThan(providerLoad);
    expect(providerLoad).toBeLessThan(latestOwnerRead);
    expect(latestOwnerRead).toBeLessThan(bridgedCacheWrite);
    expect(bridgeHelperCode).toContain(
      'if (!usedShare.shareConfig?.singleton && version !== usedShare.version) return;'
    );
    expect(bridgeHelperCode).not.toContain('if (!usedShare.shareConfig?.singleton) return;');
    expect(bridgeHelperCode).toContain('if (usedShare.canLiveRebind === false) return;');
    expect(bridgeHelperCode).toContain(
      'if (usedShare.shareConfig?.import === false && __mfMatchesSharedProvider(provider, usedShare)) return;'
    );
    expect(bridgeHelperCode.indexOf('shareConfig?.import === false')).toBeLessThan(providerLoad);
    expect(bridgeHelperCode.indexOf('if (usedShare.canLiveRebind === false) return;')).toBeLessThan(
      providerLoad
    );
    expect(bridgeHelperCode).toContain(
      '__mfWriteSharedCache(\n          __mfModuleCache.share,\n          usedCacheDescriptor,\n          normalized,\n          actualSelection.from'
    );
    expect(bridgeHelperCode).not.toContain('const cacheDescriptor =');
    expect(bridgeHelperCode.match(/__mfWriteSharedCache\(/g)).toHaveLength(1);
    expect(bridgeHelperCode).toContain("Failed to bridge external shared module \"' + pkg + '\"'");
    const initializeSharingCall = code.indexOf(
      `await Promise.all(await initRes.initializeSharing('default'`
    );
    const exactBridgeCall = code.indexOf(
      'await __mfBridgeExternalSharedProvider(',
      initializeSharingCall
    );
    expect(code.indexOf('if (initScope.indexOf(initToken) >= 0) return;')).toBeLessThan(
      exactBridgeCall
    );
    expect(initializeSharingCall).toBeGreaterThan(-1);
    expect(initializeSharingCall).toBeLessThan(exactBridgeCall);
    const exactBridgeCode = code.slice(exactBridgeCall, code.indexOf('const allInstances ='));
    expect(exactBridgeCode).toContain('shared[pkg]');
    expect(exactBridgeCode).toContain('initialShared[pkg]');
    expect(exactBridgeCode.indexOf('shared[pkg]')).toBeLessThan(
      exactBridgeCode.indexOf('initialShared[pkg]')
    );
    expect(exactBridgeCode).toContain('undefined');
    expect(code).not.toContain('const initFrom =');
    expect(code).not.toContain('expectedFrom');
    expect(code).not.toContain('__mfModuleCache.share[usedCacheKey] = normalized;');
    expect(code.match(/runtimeResolveShareHook/g)).toHaveLength(2);
    expect(code).toContain(
      'const __mfIsOwnStub = (candidate) => candidate === share || candidate?.shareConfig?.import === false;'
    );
    expect(code).toContain('if (__mfIsOwnStub(provider)) return;');
    expect(code.indexOf('if (__mfIsOwnStub(provider)) return;')).toBeLessThan(
      code.indexOf(
        'const loadedShare = await __mfLoadPinnedRuntimeShare(',
        code.indexOf('const __mfResolveImportFalseShared')
      )
    );
  });

  it('materializes only an originally passed root provider replaced by a later instance', async () => {
    const getScopeRootProvider = await getScopeRootProviderResolver();
    const shared = {};
    const loading = Promise.resolve(() => ({ marker: 'host-react' }));
    const lib = () => ({ marker: 'loaded-host-react' });
    const rootProvider = { from: 'host', version: '18.3.1', loading, lib };
    const configuredRootProvider = { from: 'host', version: '18.3.1' };
    const root = {
      options: {
        name: 'host',
        shared: { react: [configuredRootProvider] },
      },
      shareScopeMap: { default: shared },
    };
    const sibling = {
      options: { name: 'rspack' },
      shareScopeMap: { default: shared },
    };

    const selectedRootProvider = getScopeRootProvider(
      [root, sibling],
      root,
      shared,
      'default',
      'react',
      '18.3.1',
      { from: 'rspack' },
      rootProvider,
      'version-first'
    );
    expect(selectedRootProvider).toBe(rootProvider);
    expect(selectedRootProvider).toMatchObject({ loading, lib });
    expect(
      getScopeRootProvider(
        [root, sibling],
        root,
        shared,
        'default',
        'react',
        '18.3.1',
        { from: 'rspack' },
        undefined,
        'version-first'
      )
    ).toBeUndefined();
    expect(
      getScopeRootProvider(
        [root, sibling],
        root,
        shared,
        'default',
        'react',
        '18.3.1',
        { from: 'rspack' },
        { from: 'other-host' },
        'version-first'
      )
    ).toBeUndefined();
    expect(
      getScopeRootProvider(
        [root, sibling],
        root,
        shared,
        'default',
        'react',
        '18.3.1',
        { from: 'rspack' },
        rootProvider,
        'loaded-first'
      )
    ).toBeUndefined();

    const staleConfiguredRoot = {
      options: {
        name: 'host',
        shared: { react: [{ from: 'stale-host', version: '18.3.1' }] },
      },
      shareScopeMap: { default: shared },
    };
    expect(
      getScopeRootProvider(
        [staleConfiguredRoot, sibling],
        staleConfiguredRoot,
        shared,
        'default',
        'react',
        '18.3.1',
        { from: 'rspack' },
        rootProvider,
        'version-first'
      )
    ).toBe(rootProvider);

    const unconfiguredRoot = {
      options: { name: 'host' },
      shareScopeMap: { default: shared },
    };
    expect(
      getScopeRootProvider(
        [unconfiguredRoot, sibling],
        unconfiguredRoot,
        shared,
        'default',
        'react',
        '18.3.1',
        { from: 'rspack' },
        rootProvider,
        'version-first'
      )
    ).toBe(rootProvider);
    expect(
      getScopeRootProvider(
        [unconfiguredRoot, sibling],
        unconfiguredRoot,
        shared,
        'default',
        'react',
        '18.3.1',
        { from: 'rspack' },
        { from: 'other-host', version: '18.3.1' },
        'version-first'
      )
    ).toBeUndefined();
  });

  it('loads unresolved Webpack providers through the pinned runtime path', async () => {
    normalizedSharedMock.mockReturnValue({
      'react-dom': {
        name: 'react-dom',
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
    mod.addUsedShares('react-dom');

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
    const materializedBridgeCode = code.slice(
      code.indexOf('const __mfBridgeMaterializedProvider ='),
      code.indexOf('const __mfBridgeExternalSharedProvider =')
    );
    const webpackProviderGuard = 'if (!directFactory && isWebpackProvider(provider)) return;';
    const lazyProviderAwait =
      'if (!directFactory && provider.loading) directFactory = await provider.loading;';

    expect(materializedBridgeCode).toContain(webpackProviderGuard);
    expect(materializedBridgeCode.indexOf(webpackProviderGuard)).toBeLessThan(
      materializedBridgeCode.indexOf(lazyProviderAwait)
    );

    const externalBridgeCode = code.slice(
      code.indexOf('const __mfBridgeExternalSharedProvider ='),
      code.indexOf('for (const batch of __mfMaterializedShareBatches)')
    );
    const externalProviderGuard =
      'isWebpackProvider(provider) &&\n          !provider.lib &&\n          !provider.loaded';
    expect(externalBridgeCode).not.toContain(externalProviderGuard);
    expect(externalBridgeCode).not.toContain(
      'if (__mfGetPendingExternalSharedProvider(pkg, usedShare)) return;'
    );
    expect(code).toContain(
      "const pendingExternalProvider = typeof __mfGetPendingExternalSharedProvider === 'function'"
    );
    expect(code).toContain(
      'if (__mfGetPendingExternalSharedProvider(pkg, share, initialShared[pkg])) return;'
    );
    expect(externalBridgeCode).toContain('const loadedShare = await __mfLoadPinnedRuntimeShare(');

    const detectorStart = code.indexOf('function isWebpackProvider(provider) {');
    const detectorEnd = code.indexOf('const __mfUsesWebpackShareScope', detectorStart);
    const isWebpackProvider = new Function(
      `${code.slice(detectorStart, detectorEnd)}; return isWebpackProvider;`
    )() as (provider: unknown) => boolean;
    const webpackGet = new Function(
      'return function webpackGet() { return __webpack_require__("react"); };'
    )();
    const minifiedWebpackGet = new Function('return ()=>i.e(796).then((()=>()=>i(796)))')();

    expect(isWebpackProvider({ get: webpackGet })).toBe(true);
    expect(isWebpackProvider({ get: minifiedWebpackGet })).toBe(true);
    expect(isWebpackProvider({ get: () => Promise.resolve(() => ({})) })).toBe(false);
    expect(isWebpackProvider({})).toBe(false);
    expect(code).toContain('const isWebpackScope = !scopeRoot &&');
    expect(code).toContain(
      'const runtimeScope = isWebpackScope ? __mfCloneShareScope(hostScope) : hostScope;'
    );
    expect(code).toContain('if (webpackScopes.length === 0) return;');
    expect(code).toContain('for (const { host, runtime } of webpackScopes)');
  });

  it('restores a plain host provider from the pre-init snapshot after remote registration', async () => {
    const getScopeRootProvider = await getScopeRootProviderResolver();
    const hostGet = vi.fn(async () => () => ({ marker: 'host-react' }));
    const passedProvider = {
      from: 'webpack-host',
      version: '18.3.1',
      get: hostGet,
    };
    const rewrittenProvider = {
      ...passedProvider,
      from: 'vite-remote',
    };
    const shared = { react: { '18.3.1': rewrittenProvider } };
    const remote = {
      options: { name: 'vite-remote' },
      shareScopeMap: { default: shared },
    };

    expect(
      getScopeRootProvider(
        [remote],
        undefined,
        shared,
        'default',
        'react',
        '18.3.1',
        rewrittenProvider,
        passedProvider,
        'version-first'
      )
    ).toBe(passedProvider);
    expect(
      getScopeRootProvider(
        [],
        undefined,
        shared,
        'default',
        'react',
        '18.3.1',
        rewrittenProvider,
        passedProvider,
        'version-first'
      )
    ).toBeUndefined();
  });

  it('keeps speculative external selection outside the public resolveShare lifecycle', async () => {
    const [selectExternalProvider, resolveExternalProvider] = await Promise.all([
      getExternalSharedProviderSelector(),
      getExternalSharedProviderResolver(),
    ]);
    const rootProvider = { from: 'host', version: '18.3.1' };
    const laterProvider = { from: 'rspack', version: '18.3.1' };
    const shared = { react: { '18.3.1': laterProvider } };
    const root = {
      options: { name: 'host', shared: { react: [rootProvider] } },
      shareScopeMap: { default: shared },
    };
    const sibling = {
      options: { name: 'rspack' },
      shareScopeMap: { default: shared },
    };
    const localProvider = {
      from: 'remote',
      version: '18.3.1',
      shareConfig: { singleton: true, requiredVersion: '^18.0.0' },
    };
    const resolveShareHook = {
      emit: vi.fn(() => {
        throw new Error('public resolveShare hook must not run during speculation');
      }),
    };

    const selectedProvider = (selectExternalProvider as (...args: any[]) => unknown)(
      shared.react,
      'react',
      localProvider,
      'version-first',
      resolveShareHook
    );
    const providerEntry = {
      version: '18.3.1',
      provider: selectedProvider,
      registered: true,
    };

    expect(selectedProvider).toBe(laterProvider);
    expect(resolveShareHook.emit).not.toHaveBeenCalled();
    expect(
      resolveExternalProvider(
        [root, sibling],
        root,
        shared,
        'default',
        'react',
        providerEntry,
        selectedProvider,
        rootProvider,
        'version-first'
      )
    ).toEqual({ provider: rootProvider, scopeRootProvider: rootProvider });
  });

  it('does not give parent authority to a provider registered after the initial snapshot', async () => {
    const resolveExternalProvider = await getExternalSharedProviderResolver();
    const laterProvider = { from: 'rspack', version: '19.0.0' };
    const staleProvider = { from: 'stale', version: '19.0.0' };
    const shared = { react: { '19.0.0': laterProvider } };

    expect(
      resolveExternalProvider(
        [],
        undefined,
        shared,
        'default',
        'react',
        { version: '19.0.0', provider: laterProvider, registered: true },
        laterProvider,
        undefined,
        'version-first'
      )
    ).toBeUndefined();
    expect(
      resolveExternalProvider(
        [],
        undefined,
        shared,
        'default',
        'react',
        { version: '19.0.0', provider: staleProvider, registered: true },
        staleProvider,
        undefined,
        'version-first'
      )
    ).toBeUndefined();
  });

  it('preserves the default provider through a passthrough resolveShare wrapper', async () => {
    const rootFactory = () => ({ marker: 'root-react' });
    const laterFactory = () => ({ marker: 'later-react' });
    const rootProvider: RuntimeBridgeProvider = {
      from: 'host',
      version: '18.3.1',
      lib: rootFactory,
      loaded: true,
    };
    const laterProvider: RuntimeBridgeProvider = {
      from: 'rspack',
      version: '18.3.1',
      lib: laterFactory,
      loaded: true,
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': laterProvider,
    };
    const lifecycle: string[] = [];
    const inspectResolveShare = vi.fn((args: RuntimeResolveShareArgs) => {
      lifecycle.push('resolveShare');
      expect(args.shareScopeMap?.default.react['18.3.1']).toBe(laterProvider);
      const defaultResolver = args.resolver;
      return {
        ...args,
        resolver: (...resolverArgs: unknown[]) => defaultResolver(...resolverArgs),
      };
    });
    let recordSelection!: (
      provider: RuntimeBridgeProvider,
      shareInfo?: Record<string, unknown>,
      shareScopeMap?: RuntimeResolveShareArgs['shareScopeMap']
    ) => void;
    const loadPinnedShare = await getRuntimeBridgeLoader(
      {
        loadShare: async (_pkg, options) => {
          lifecycle.push('loadShare:start');
          const pinnedProvider = versionMap['18.3.1'];
          expect(pinnedProvider).not.toBe(laterProvider);
          recordSelection(
            pinnedProvider,
            (options as { customShareInfo?: Record<string, unknown> }).customShareInfo,
            { default: { react: versionMap } }
          );
          lifecycle.push('loadShare:end');
          return rootFactory;
        },
      },
      inspectResolveShare
    );
    recordSelection = loadPinnedShare.recordSelection;

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        laterProvider,
        rootProvider
      )
    ).resolves.toMatchObject({
      selection: { version: '18.3.1', from: 'host' },
      resolved: { marker: 'root-react' },
    });
    expect(inspectResolveShare).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(['loadShare:start', 'resolveShare', 'loadShare:end']);
    expect(versionMap['18.3.1']).not.toBe(laterProvider);
    expect(versionMap['18.3.1']).toMatchObject({ from: 'host', loaded: true });
  });

  it('lets resolveShare select the real pre-pin provider', async () => {
    const rootFactory = () => ({ marker: 'root-react' });
    const laterFactory = () => ({ marker: 'later-react' });
    const rootProvider: RuntimeBridgeProvider = {
      from: 'host',
      version: '18.3.1',
      lib: rootFactory,
      loaded: true,
    };
    const laterProvider: RuntimeBridgeProvider = {
      from: 'rspack',
      version: '18.3.1',
      lib: laterFactory,
      loaded: true,
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': laterProvider,
    };
    const lifecycle: string[] = [];
    const overrideResolveShare = vi.fn((args: RuntimeResolveShareArgs) => {
      lifecycle.push('resolveShare');
      const selectedProvider = args.shareScopeMap?.default.react['18.3.1'];
      expect(selectedProvider).toBe(laterProvider);
      return {
        ...args,
        resolver: () => ({ shared: selectedProvider! }),
      };
    });
    let recordSelection!: (
      provider: RuntimeBridgeProvider,
      shareInfo?: Record<string, unknown>,
      shareScopeMap?: RuntimeResolveShareArgs['shareScopeMap']
    ) => void;
    const loadPinnedShare = await getRuntimeBridgeLoader(
      {
        loadShare: async (_pkg, options) => {
          lifecycle.push('loadShare:start');
          const pinnedProvider = versionMap['18.3.1'];
          expect(pinnedProvider).not.toBe(laterProvider);
          recordSelection(
            pinnedProvider,
            (options as { customShareInfo?: Record<string, unknown> }).customShareInfo,
            { default: { react: versionMap } }
          );
          lifecycle.push('loadShare:end');
          return laterFactory;
        },
      },
      overrideResolveShare
    );
    recordSelection = loadPinnedShare.recordSelection;

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        laterProvider,
        rootProvider
      )
    ).resolves.toMatchObject({
      provider: laterProvider,
      selection: { version: '18.3.1', from: 'rspack' },
      resolved: { marker: 'later-react' },
    });
    expect(overrideResolveShare).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(['loadShare:start', 'resolveShare', 'loadShare:end']);
    expect(versionMap['18.3.1']).toBe(laterProvider);
  });

  it('awaits and materializes a loading-only external provider', async () => {
    let resolveFactory!: (factory: () => unknown) => void;
    const exactExports = { marker: 'host-react', useState: vi.fn() };
    const factory = vi.fn(() => exactExports);
    const provider: RuntimeBridgeProvider = {
      from: 'host',
      version: '18.3.1',
      loading: new Promise<() => unknown>((resolve) => {
        resolveFactory = resolve;
      }),
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': provider,
    };
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: createRuntimeShareLoader(versionMap) as (
        pkg: string,
        options: unknown
      ) => Promise<unknown>,
    });

    const pending = loadPinnedShare(
      'react',
      { requiredVersion: '18.3.1' },
      versionMap,
      '18.3.1',
      provider,
      provider
    );
    expect(versionMap['18.3.1'].lib).toBeUndefined();

    resolveFactory(factory);

    await expect(pending).resolves.toMatchObject({
      selection: { version: '18.3.1', from: 'host' },
      resolved: exactExports,
    });
    expect(versionMap['18.3.1']).toMatchObject({ lib: factory, loaded: true });
    expect(factory).toHaveBeenCalledOnce();
  });

  it('attributes concurrent runtime loads by factory identity', async () => {
    let resolveOne!: (factory: () => unknown) => void;
    let resolveTwo!: (factory: () => unknown) => void;
    const one = new Promise<() => unknown>((resolve) => {
      resolveOne = resolve;
    });
    const two = new Promise<() => unknown>((resolve) => {
      resolveTwo = resolve;
    });
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '1.0.0': { from: 'host-one', get: () => one },
      '2.0.0': { from: 'host-two', get: () => two },
    };
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: createRuntimeShareLoader(versionMap) as (
        pkg: string,
        options: unknown
      ) => Promise<unknown>,
    });

    const loadOne = loadPinnedShare(
      'dep',
      { requiredVersion: '1.0.0' },
      versionMap,
      '1.0.0',
      versionMap['1.0.0'],
      versionMap['1.0.0']
    );
    const loadTwo = loadPinnedShare(
      'dep',
      { requiredVersion: '2.0.0' },
      versionMap,
      '2.0.0',
      versionMap['2.0.0'],
      versionMap['2.0.0']
    );

    resolveTwo(() => ({ value: 2 }));
    resolveOne(() => ({ value: 1 }));

    await expect(loadOne).resolves.toMatchObject({
      selection: { version: '1.0.0', from: 'host-one' },
      resolved: { value: 1 },
    });
    await expect(loadTwo).resolves.toMatchObject({
      selection: { version: '2.0.0', from: 'host-two' },
      resolved: { value: 2 },
    });
  });

  it('attributes a runtime-selected provider when compatible versions share a factory', async () => {
    const sharedFactory = () => ({ marker: 'shared-react' });
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.2.0': {
        from: 'host-react-18.2',
        version: '18.2.0',
        lib: sharedFactory,
        loaded: true,
      },
      '18.3.1': {
        from: 'host-react-18.3',
        version: '18.3.1',
        lib: sharedFactory,
        loaded: true,
      },
    };
    let recordSelection!: (
      provider: RuntimeBridgeProvider,
      shareInfo?: Record<string, unknown>
    ) => void;
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async (_pkg, options) => {
        recordSelection(
          versionMap['18.3.1'],
          (options as { customShareInfo?: Record<string, unknown> }).customShareInfo
        );
        return sharedFactory;
      },
    });
    recordSelection = loadPinnedShare.recordSelection;

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        versionMap['18.3.1'],
        versionMap['18.3.1']
      )
    ).resolves.toMatchObject({
      selection: { version: '18.3.1', from: 'host-react-18.3' },
      resolved: { marker: 'shared-react' },
    });
  });

  it('attributes a provider registered while the runtime load is pending', async () => {
    const selectedFactory = () => ({ marker: 'plugin-provider' });
    const originalProvider: RuntimeBridgeProvider = {
      from: 'original-host',
      version: '1.0.0',
      get: async () => () => ({ marker: 'original-provider' }),
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '1.0.0': originalProvider,
    };
    let recordSelection!: (provider: RuntimeBridgeProvider) => void;
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async () => {
        const pluginProvider = (versionMap['2.0.0'] = {
          from: 'plugin-host',
          version: '2.0.0',
          lib: selectedFactory,
          loaded: true,
        });
        recordSelection(pluginProvider);
        pluginProvider.from = 'remote';
        return selectedFactory;
      },
    });
    recordSelection = loadPinnedShare.recordSelection;

    await expect(
      loadPinnedShare(
        'dep',
        { requiredVersion: '*' },
        versionMap,
        '1.0.0',
        originalProvider,
        originalProvider
      )
    ).resolves.toMatchObject({
      selection: { version: '2.0.0', from: 'plugin-host' },
      resolved: { marker: 'plugin-provider' },
    });
    expect(versionMap['1.0.0']).toBe(originalProvider);
    expect(versionMap['2.0.0'].from).toBe('plugin-host');
  });

  it('restores external provenance after the runtime tags a pinned load as local', async () => {
    const factory = () => ({ marker: 'host-react' });
    const provider: RuntimeBridgeProvider = {
      from: 'host',
      version: '18.3.1',
      get: async () => factory,
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = { '18.3.1': provider };
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async () => {
        versionMap['18.3.1'].from = 'remote';
        versionMap['18.3.1'].lib = factory;
        versionMap['18.3.1'].loaded = true;
        return factory;
      },
    });

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        provider,
        provider
      )
    ).resolves.toMatchObject({
      selection: { version: '18.3.1', from: 'host' },
      resolved: { marker: 'host-react' },
    });
    expect(versionMap['18.3.1'].from).toBe('host');
  });

  it('loads a hook-selected provider that is not registered in the share map', async () => {
    const factory = () => ({ marker: 'plugin-react' });
    const registeredProvider: RuntimeBridgeProvider = {
      from: 'registered-host',
      version: '18.2.0',
      get: async () => () => ({ marker: 'registered-react' }),
    };
    const pluginProvider: RuntimeBridgeProvider = {
      from: 'plugin-host',
      version: '18.3.1',
      get: async () => factory,
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.2.0': registeredProvider,
    };
    let recordSelection!: (
      provider: RuntimeBridgeProvider,
      shareInfo?: Record<string, unknown>
    ) => void;
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async (_pkg, options) => {
        recordSelection(
          pluginProvider,
          (options as { customShareInfo?: Record<string, unknown> }).customShareInfo
        );
        pluginProvider.from = 'remote';
        return factory;
      },
    });
    recordSelection = loadPinnedShare.recordSelection;

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.2.0',
        registeredProvider,
        registeredProvider
      )
    ).resolves.toMatchObject({
      provider: pluginProvider,
      selection: {
        version: '18.3.1',
        from: 'plugin-host',
        registered: false,
      },
      resolved: { marker: 'plugin-react' },
    });
    expect(versionMap['18.2.0']).toBe(registeredProvider);
    expect(versionMap['18.3.1']).toBeUndefined();
    expect(pluginProvider.from).toBe('plugin-host');
    expect(pluginProvider.lib).toBeUndefined();
  });

  it('loads an unregistered hook provider whose factory was already materialized', async () => {
    const factory = () => ({ marker: 'plugin-react' });
    const pluginProvider: RuntimeBridgeProvider = {
      from: 'plugin-host',
      version: '18.3.1',
      lib: factory,
      loaded: true,
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {};
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async () => factory,
    });

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        undefined,
        pluginProvider,
        false
      )
    ).resolves.toMatchObject({
      provider: pluginProvider,
      selection: {
        version: '18.3.1',
        from: 'plugin-host',
        registered: false,
      },
      resolved: { marker: 'plugin-react' },
    });
    expect(versionMap['18.3.1']).toBeUndefined();
  });

  it('restores a rejected pinned runtime load so it can retry', async () => {
    const get = vi
      .fn<() => Promise<() => unknown>>()
      .mockRejectedValueOnce(new Error('broken runtime provider'))
      .mockResolvedValueOnce(() => ({ marker: 'host-react' }));
    const currentProvider = { from: 'host', get };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': currentProvider,
    };
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: createRuntimeShareLoader(versionMap) as (
        pkg: string,
        options: unknown
      ) => Promise<unknown>,
    });

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '18.3.1' },
        versionMap,
        '18.3.1',
        versionMap['18.3.1'],
        versionMap['18.3.1']
      )
    ).rejects.toThrow('broken runtime provider');
    expect(versionMap['18.3.1']).toBe(currentProvider);

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '18.3.1' },
        versionMap,
        '18.3.1',
        versionMap['18.3.1'],
        versionMap['18.3.1']
      )
    ).resolves.toMatchObject({
      selection: { version: '18.3.1', from: 'host' },
      resolved: { marker: 'host-react' },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('removes an absent pinned provider when the runtime returns false', async () => {
    const provider: RuntimeBridgeProvider = {
      from: 'plugin-host',
      version: '18.3.1',
      get: async () => () => ({ marker: 'plugin-react' }),
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {};
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async () => false,
    });

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        undefined,
        provider,
        false
      )
    ).resolves.toBeUndefined();
    expect(versionMap['18.3.1']).toBeUndefined();
  });

  it('preserves a provider that replaces a pin before a rejected runtime load settles', async () => {
    const currentProvider: RuntimeBridgeProvider = {
      from: 'host',
      get: async () => () => ({ marker: 'host-react' }),
    };
    const replacement: RuntimeBridgeProvider = {
      from: 'later-host',
      lib: () => ({ marker: 'later-react' }),
    };
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': currentProvider,
    };
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async () => {
        versionMap['18.3.1'] = replacement;
        throw new Error('broken runtime provider');
      },
    });

    await expect(
      loadPinnedShare(
        'react',
        { requiredVersion: '^18.0.0' },
        versionMap,
        '18.3.1',
        currentProvider,
        currentProvider
      )
    ).rejects.toThrow('broken runtime provider');
    expect(versionMap['18.3.1']).toBe(replacement);
  });

  it('does not resolve a provider replaced during an awaited runtime load', async () => {
    let markStarted!: () => void;
    let resolveFactory!: (factory: () => unknown) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pendingFactory = new Promise<() => unknown>((resolve) => {
      resolveFactory = resolve;
    });
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': {
        from: 'host',
        get: () => {
          markStarted();
          return pendingFactory;
        },
      },
    };
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: createRuntimeShareLoader(versionMap) as (
        pkg: string,
        options: unknown
      ) => Promise<unknown>,
    });
    const load = loadPinnedShare(
      'react',
      { requiredVersion: '18.3.1' },
      versionMap,
      '18.3.1',
      versionMap['18.3.1'],
      versionMap['18.3.1']
    );

    await started;
    expect(versionMap['18.3.1']).toMatchObject({
      from: 'host',
      version: '18.3.1',
      scope: ['default'],
    });
    const replacement = { from: 'later-host', lib: () => ({ marker: 'later-react' }) };
    versionMap['18.3.1'] = replacement;
    resolveFactory(() => ({ marker: 'stale-react' }));

    await expect(load).resolves.toBeUndefined();
    expect(versionMap['18.3.1']).toBe(replacement);
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
      '__mfReadSharedCacheOwner(__mfModuleCache.share, singletonCacheDescriptor)'
    );
    expect(code.indexOf('const singletonCacheDescriptor')).toBeLessThan(
      code.indexOf(`await Promise.all(await initRes.initializeSharing('default'`)
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

    const initializeSharingCall = code.indexOf(
      `await Promise.all(await initRes.initializeSharing('default'`
    );
    const bridgeCall = code.indexOf('await __mfBridgeExternalSharedProvider(');
    expect(initializeSharingCall).toBeGreaterThan(-1);
    expect(bridgeCall).toBeGreaterThan(initializeSharingCall);
    expect(code).not.toContain(
      'const mod = await import("virtual:mf:remote__prebuild__react__prebuild__.js")'
    );
  });

  it('preserves loaded singleton precedence for version-first provider selection', async () => {
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
    ).toBe(react18);
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

  it('ignores import:false placeholders when selecting an external provider', async () => {
    const selectProvider = await getExternalSharedProviderSelector();
    const localReact = {
      from: 'host',
      version: '18.3.1',
      shareConfig: { singleton: true, requiredVersion: false as const },
    };
    const remotePlaceholder = {
      from: 'remote',
      shareConfig: { singleton: true, import: false, requiredVersion: false },
    };

    expect(
      selectProvider({ '18.3.1': remotePlaceholder }, 'react', localReact, 'loaded-first')
    ).toBeUndefined();
  });

  it("does not satisfy-check the container's own import:false stub", async () => {
    const selectProvider = await getExternalSharedProviderSelector();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ownStub = {
      from: 'host',
      version: '0.0.0',
      shareConfig: { singleton: true, import: false, requiredVersion: '^1.0.0' },
    };

    try {
      expect(
        selectProvider({ '0.0.0': ownStub }, 'demo-lib', ownStub, 'loaded-first')
      ).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('compares external and local singleton providers with version-first', async () => {
    const selectExternalProvider = await getExternalSharedProviderSelector();
    const hostGet = vi.fn();
    const hostReact18 = { from: 'host-react-18', get: hostGet };
    const localReact19 = {
      version: '19.2.0',
      from: 'remote-react-19',
      scope: ['default'],
      loaded: false,
      shareConfig: {
        singleton: true,
        requiredVersion: '^19.0.0',
        strictVersion: false,
      },
    };

    expect(
      selectExternalProvider({ '18.3.1': hostReact18 }, 'react', localReact19, 'version-first')
    ).toBeUndefined();
    expect(hostGet).not.toHaveBeenCalled();

    const localReact17 = {
      ...localReact19,
      version: '17.0.2',
      from: 'remote-react-17',
      shareConfig: {
        ...localReact19.shareConfig,
        requiredVersion: '^17.0.2',
      },
    };
    expect(
      selectExternalProvider({ '18.3.1': hostReact18 }, 'react', localReact17, 'version-first')
    ).toBe(hostReact18);
    expect(
      selectExternalProvider(
        { '17.0.2': { ...localReact17, lib: () => ({ marker: 'local-clone' }) } },
        'react',
        localReact17,
        'version-first'
      )
    ).toBeUndefined();
    expect(hostGet).not.toHaveBeenCalled();
  });

  it('selects a runtime-only host provider for import:false regardless of its sentinel version', async () => {
    const selectExternalProvider = await getExternalSharedProviderSelector();
    const hostProvider = {
      from: 'runtime-host',
      lib: () => ({ marker: 'host' }),
      loaded: true,
    };
    const localStub = {
      version: '1.2.3',
      from: 'remote',
      scope: ['default'],
      loaded: false,
      shareConfig: {
        singleton: true,
        import: false,
        requiredVersion: '*',
        strictVersion: false,
      },
    };

    expect(
      selectExternalProvider({ '0': hostProvider }, 'host-only-package', localStub, 'version-first')
    ).toBe(hostProvider);
  });

  it.each([false, true])(
    'keeps a loaded host singleton ahead of a newer local fallback with version-first (local loaded: %s)',
    async (localLoaded) => {
      const selectExternalProvider = await getExternalSharedProviderSelector();
      const hostReact18 = {
        from: 'host-react-18',
        lib: () => ({ marker: 'host-react' }),
        loaded: true,
      };
      const localReact19 = {
        version: '19.2.0',
        from: 'remote-react-19',
        scope: ['default'],
        loaded: localLoaded,
        ...(localLoaded ? { lib: () => ({ marker: 'local-react' }) } : {}),
        shareConfig: {
          singleton: true,
          requiredVersion: '^19.0.0',
          strictVersion: false,
        },
      };

      expect(
        selectExternalProvider({ '18.3.1': hostReact18 }, 'react', localReact19, 'version-first')
      ).toBe(hostReact18);
    }
  );

  it('selects only active external providers with loaded-first', async () => {
    const selectExternalProvider = await getExternalSharedProviderSelector();
    const hostGet = vi.fn(async () => () => ({ marker: 'host-react' }));
    const hostReact18 = { from: 'host-react-18', get: hostGet, loaded: 1 };
    const localReact19 = {
      version: '19.2.0',
      from: 'remote-react-19',
      scope: ['default'],
      loaded: false,
      shareConfig: {
        singleton: true,
        requiredVersion: false as const,
        strictVersion: false,
      },
    };

    expect(
      selectExternalProvider({ '18.3.1': hostReact18 }, 'react', localReact19, 'loaded-first')
    ).toBe(hostReact18);

    expect(
      selectExternalProvider(
        { '18.3.1': { from: hostReact18.from, get: hostGet } },
        'react',
        localReact19,
        'loaded-first'
      )
    ).toBeUndefined();
    expect(hostGet).not.toHaveBeenCalled();
  });

  it('retains an unloaded same-version parent provider with loaded-first', async () => {
    const selectExternalProvider = await getExternalSharedProviderSelector();
    const hostGet = vi.fn(async () => () => ({ marker: 'host-react' }));
    const hostReact = { from: 'host', get: hostGet };
    const localReact = {
      version: '18.3.1',
      from: 'remote',
      scope: ['default'],
      loaded: false,
      shareConfig: {
        singleton: true,
        requiredVersion: '^18.0.0',
        strictVersion: false,
      },
    };

    expect(
      selectExternalProvider({ '18.3.1': hostReact }, 'react', localReact, 'loaded-first')
    ).toBe(hostReact);
    expect(hostGet).not.toHaveBeenCalled();
  });

  it('does not emit the public resolve hook during external provider speculation', async () => {
    const selectProvider = await getExternalSharedProviderSelector();
    const pluginProvider = { from: 'plugin-provider', get: vi.fn() };
    const defaultProvider = { from: 'default-provider', get: vi.fn() };
    const localProvider = {
      from: 'remote',
      version: '0.5.0',
      shareConfig: { singleton: true, requiredVersion: '*' },
    };
    const resolveShareHook = {
      emit: vi.fn(),
    };

    expect(
      (selectProvider as (...args: any[]) => unknown)(
        {
          '1.0.0': pluginProvider,
          '2.0.0': defaultProvider,
        },
        'react',
        localProvider,
        'version-first',
        resolveShareHook
      )
    ).toBe(defaultProvider);
    expect(resolveShareHook.emit).not.toHaveBeenCalled();
  });

  it('tracks hook-selected providers that are not the registered map object', async () => {
    const findProviderEntry = await getSharedProviderEntryResolver();
    const registered = { from: 'registered-host', version: '1.0.0' };
    const versions = { '1.0.0': registered };
    const pluginProvider = { from: 'plugin-host', version: '2.0.0' };

    expect(findProviderEntry(versions, registered)).toEqual({
      version: '1.0.0',
      provider: registered,
      registered: true,
    });
    expect(findProviderEntry(versions, pluginProvider)).toEqual({
      version: '2.0.0',
      provider: pluginProvider,
      registered: false,
    });
    const wrappedProvider = { from: 'registered-host' };
    expect(findProviderEntry(versions, wrappedProvider)).toEqual({
      version: '1.0.0',
      provider: wrappedProvider,
      registered: false,
    });
    expect(
      findProviderEntry(
        {
          '1.0.0': registered,
          '1.1.0': { from: 'registered-host' },
        },
        wrappedProvider
      )
    ).toBeUndefined();
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

  it('does not import runtime share helpers when no shared dependency is configured', async () => {
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
    expect(code).toContain('const loadedShare = await __mfLoadPinnedRuntimeShare(');
    expect(code).toContain(
      'if (__mfReadSharedCache(__mfModuleCache.share, cacheDescriptor) !== undefined) continue;'
    );
    expect(code).toContain(
      'providerSelection.registered &&\n        versionMap?.[providerSelection.version] !== actualProvider'
    );
    expect(code).not.toContain('versions[Object.keys(versions)[0]]');
  });

  it('aggregates materialized global providers before selecting a shared version', async () => {
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
    expect(code).toContain('if (!usedShare) continue;');
    const globalBridgeCode = code.slice(
      code.indexOf('const allInstances ='),
      code.indexOf("console.error('[Module Federation] Failed to bridge external shared modules'")
    );
    expect(globalBridgeCode).toContain('const globalVersionsByPackage = Object.create(null);');
    expect(globalBridgeCode).toContain('for (const [, scopes] of Object.entries(allInstances))');
    expect(globalBridgeCode).toContain('if (!provider.lib) continue;');
    expect(globalBridgeCode).toContain('const passedVersions = initialShared[pkg];');
    expect(globalBridgeCode).toContain('const bridgeSelection = bridgeSelections.get(pkg);');
    expect(globalBridgeCode).toContain('if (!passedVersions) continue;');
    expect(globalBridgeCode).toContain('if (!bridgeSelection) continue;');
    expect(globalBridgeCode).toContain('if (bridgeSelection.version !== version) continue;');
    expect(globalBridgeCode).toContain(
      'if (!__mfMatchesSharedProvider(provider, bridgeSelection.provider)) continue;'
    );
    expect(globalBridgeCode).toContain('const passedProvider = passedVersions[version];');
    expect(globalBridgeCode).toContain('const matchesPassedProvider =');
    expect(globalBridgeCode).toContain(
      'passedProvider?.from && provider.from === passedProvider.from'
    );
    expect(globalBridgeCode).toContain(
      'if (provider === usedShare || (usedShare.from && provider.from === usedShare.from)) continue;'
    );
    expect(globalBridgeCode).toContain(
      'for (const batch of __mfMaterializedShareBatches) await Promise.all'
    );
    expect(globalBridgeCode).toContain('const versionMap = globalVersionsByPackage[pkg];');
    expect(globalBridgeCode.indexOf('for (const [, scopes]')).toBeLessThan(
      globalBridgeCode.indexOf('await __mfBridgeExternalSharedProvider(')
    );
    expect(globalBridgeCode).toMatch(
      /await __mfBridgeExternalSharedProvider\(\s*pkg,\s*usedShared\[pkg\],\s*versionMap,\s*initialShared\[pkg\],\s*bridgeSelections\.get\(pkg\)\s*\)/
    );
  });

  it('uses null-prototype aggregation maps for reserved shared package names', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
        internalName: '__mfe_internal__remote',
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: Object.fromEntries(
          ['constructor', 'toString', '__proto__'].map((name) => [
            name,
            {
              name,
              version: '1.0.0',
              scope: ['default'],
              shareConfig: { singleton: true, requiredVersion: false },
            },
          ])
        ),
        runtimePlugins: [],
        shareScope: 'default',
        shareStrategy: 'version-first',
      } as any,
      'virtual:exposes',
      'serve'
    );

    expect(code).toContain('const globalVersionsByPackage = Object.create(null);');
    expect(code).toContain('globalVersionsByPackage[pkg] = Object.create(null)');
  });
});
