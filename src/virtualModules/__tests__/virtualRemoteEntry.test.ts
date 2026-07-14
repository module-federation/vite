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
    strategy: 'version-first' | 'loaded-first',
    resolveShareHook?: {
      emit: (params: any) => any;
    },
    selectionState?: { resolveShareHookUsed?: boolean }
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
    strategy: 'version-first' | 'loaded-first',
    resolveShareHookUsed?: boolean
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
    strategy: 'version-first' | 'loaded-first',
    resolveShareHookUsed?: boolean
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

async function getRuntimeBridgeLoader(initRes: {
  loadShare: (pkg: string, options: unknown) => Promise<unknown>;
}) {
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
  const helperCode = code.slice(
    code.indexOf('const __mfRuntimeProviderOrigins ='),
    code.indexOf('const bridgedProviders =')
  );

  let recordSelection = (
    _provider: RuntimeBridgeProvider,
    _shareInfo?: Record<string, unknown>
  ) => {};
  const runtimeResolveShareHook = {
    on(
      listener: (args: {
        shareInfo?: Record<string, unknown>;
        resolver: () => { shared: RuntimeBridgeProvider };
      }) => {
        resolver: () => { shared: RuntimeBridgeProvider };
      }
    ) {
      recordSelection = (provider, shareInfo) => {
        const args = { shareInfo, resolver: () => ({ shared: provider }) };
        (listener(args) || args).resolver();
      };
    },
  };
  const loadPinnedShare = new Function(
    'initRes',
    'runtimeResolveShareHook',
    '__mfTransparentResolverKey',
    `${helperCode}; return __mfLoadPinnedRuntimeShare;`
  )(
    initRes,
    runtimeResolveShareHook,
    Symbol.for('module-federation.vite.transparent-resolver')
  ) as ((
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
  >) & {
    recordSelection(provider: RuntimeBridgeProvider, shareInfo?: Record<string, unknown>): void;
  };
  loadPinnedShare.recordSelection = (provider, shareInfo) => recordSelection(provider, shareInfo);
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
  const start = code.indexOf('for (const pkg of __mfDeferredSeedKeys) {');
  const endMarker = 'await __mfSeedLocalShared([pkg]);\n    }';
  const end = code.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error('runtime deferred resolution code not found');
  return code.slice(start, end + endMarker.length);
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
    expect(code).toMatch(/loaded: false,\s+eager: true,\s+from: "host"/);
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
    expect(hostInit).toContain('const __mfHostInitShareOrder = ["react","@repro/react-consumer"]');
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
    expect(code).toContain('const versionMap = shared?.[pkg]');
    expect(code.indexOf('share.shareConfig?.import !== false')).toBeLessThan(
      code.indexOf('initResolve(initRes)')
    );
    expect(code).toContain('const factory = await initRes.loadShare(pkg');
    expect(code).not.toContain('import exposesMap from');
    expect(code).not.toContain('import {usedShared, usedRemotes} from');
  });

  it('statically includes the local shared map when a local eager share is configured', async () => {
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

    expect(code).toContain(
      'import * as __mfLocalSharedImportMap from "virtual:mf-localSharedImportMap:__mfe_internal__host";'
    );
    expect(code).toContain('return __mfLocalSharedImportMap;');
    expect(code).not.toContain('retrySharedInit(() => import("virtual:mf-localSharedImportMap');
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
      'for (const [pkg, usedShare] of Object.entries(usedShared))',
      materializedBridgeCall
    );
    expect(code.slice(materializedPreSeedLoop, materializedBridgeCall)).toContain(
      'if (usedShare.treeShaking) continue;'
    );
    const aliasCacheLoop = code.indexOf(
      'for (const [pkg, share] of Object.entries(usedShared))',
      materializedBridgeCall
    );
    expect(code.slice(aliasCacheLoop, code.indexOf('const __mfSeedOrder ='))).toContain(
      'if (share.treeShaking) continue;'
    );
    expect(code).toContain('plugins: [__mfTreeShakingSnapshotPlugin(),');
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

  it('does not preload generated subpath shares from a root shared package', async () => {
    const mod = await import('../virtualRemoteEntry');

    mod.getUsedShares().clear();
    mod.addUsedShares('lit/decorators.js');

    const code = mod.generateHostAutoInitCode('"virtual:remoteEntry"', 'build');

    expect(code).toContain('const __mfHostInitShareOrder');
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
    expect(code).toContain('for (const pkg of __mfHostInitShareOrder)');
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
    // Share keys discovered after codegen still get seeded, after the ordered ones.
    expect(code).toContain('for (const pkg of Object.keys(usedShared))');
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
    const initShareScopeMapCall = code.indexOf("initRes.initShareScopeMap('default', shared);");
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
    const lateBridgeCall = code.indexOf('await __mfBridgeExternalSharedProvider(\n        pkg');

    expect(localSharedCode).toContain('canLiveRebind: true');
    expect(materializedBridgeCode).toContain(
      "if (singleton && 'version-first' !== 'loaded-first') return;"
    );
    expect(initializeSharingCall).toBeGreaterThan(-1);
    expect(lateBridgeCall).toBeGreaterThan(initializeSharingCall);
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
    expect(code).toMatch(
      /__mfWriteSharedCache\(\s*__mfModuleCache\.share,\s*cacheDescriptor,\s*__mfNormalizeRuntimeShare\(resolved\),\s*"host"\s*\)/
    );
    expect(code).not.toContain('__mfModuleCache.share[cacheKey]');
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
    expect(preSeedBridgeCode).toContain('if (!singleton && version !== usedShare.version) return;');
    expect(preSeedBridgeCode).toContain("!(provider.loaded && typeof provider.get === 'function')");
    expect(preSeedBridgeCode).toContain('directFactory = await provider.get();');
    expect(preSeedBridgeCode).toMatch(
      /__mfGetSharedCacheDescriptor\(\s*pkg,\s*singleton,\s*usedShare\.version/
    );
    expect(preSeedBridgeCode).toContain("'version-first',\n          runtimeResolveShareHook");
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
      code.indexOf('for (const [pkg, usedShare] of Object.entries(usedShared))')
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
      "__mfSelectSharedProvider(versionMap, pkg, usedShare, 'version-first', runtimeResolveShareHook)"
    );
    expect(bridgeHelperCode).toContain('const passedProvider = passedVersionMap?.[version];');
    expect(bridgeHelperCode).toContain('const externalProviderSelection = {};');
    expect(bridgeHelperCode).toContain(
      'const resolvedExternalProvider = __mfResolveExternalSharedProvider('
    );
    expect(bridgeHelperCode).toContain('externalProviderSelection.resolveShareHookUsed');
    expect(bridgeHelperCode).toContain(
      'const { provider, scopeRootProvider } = resolvedExternalProvider;'
    );
    expect(bridgeHelperCode).toContain('providerEntry.registered &&');
    expect(bridgeHelperCode).toContain('!__mfMatchesSharedProvider(liveProvider, provider)');
    expect(bridgeHelperCode).toContain('if (!resolvedExternalProvider) return;');
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
    expect(bridgeHelperCode).toContain('if (!usedShare.shareConfig?.singleton) return;');
    expect(bridgeHelperCode.indexOf('if (!usedShare.shareConfig?.singleton) return;')).toBeLessThan(
      providerLoad
    );
    expect(bridgeHelperCode).toContain('if (usedShare.canLiveRebind === false) return;');
    expect(bridgeHelperCode.indexOf('if (usedShare.canLiveRebind === false) return;')).toBeLessThan(
      providerLoad
    );
    expect(bridgeHelperCode).toContain(
      '__mfWriteSharedCache(\n          __mfModuleCache.share,\n          usedCacheDescriptor,\n          normalized,\n          actualSelection.from'
    );
    expect(bridgeHelperCode).not.toContain('const cacheDescriptor =');
    expect(bridgeHelperCode.match(/__mfWriteSharedCache\(/g)).toHaveLength(1);
    expect(bridgeHelperCode).toContain("Failed to bridge external shared module \"' + pkg + '\"'");
    const exactBridgeCall = code.indexOf('await __mfBridgeExternalSharedProvider(\n        pkg');
    expect(code.indexOf('if (initScope.indexOf(initToken) >= 0) return;')).toBeLessThan(
      exactBridgeCall
    );
    const initializeSharingCall = code.indexOf(
      `await Promise.all(await initRes.initializeSharing('default'`
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

  it('preserves a later external provider explicitly selected by the resolveShare hook', async () => {
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
    const selectionState: { resolveShareHookUsed?: boolean } = {};
    const resolveShareHook = {
      emit: (params: any) => ({
        ...params,
        resolver: () => ({
          shared: params.shareScopeMap.default.react['18.3.1'],
          useTreesShaking: false,
        }),
      }),
    };

    const selectedProvider = selectExternalProvider(
      shared.react,
      'react',
      localProvider,
      'version-first',
      resolveShareHook,
      selectionState
    );
    const providerEntry = {
      version: '18.3.1',
      provider: selectedProvider,
      registered: true,
    };

    expect(selectedProvider).toBe(laterProvider);
    expect(selectionState.resolveShareHookUsed).toBe(true);
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
        'version-first',
        false
      )
    ).toEqual({ provider: rootProvider, scopeRootProvider: rootProvider });
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
        'version-first',
        selectionState.resolveShareHookUsed
      )
    ).toEqual({ provider: laterProvider, scopeRootProvider: undefined });
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
        'version-first',
        false
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
        'version-first',
        false
      )
    ).toBeUndefined();
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
    const loadPinnedShare = await getRuntimeBridgeLoader({
      loadShare: async () => {
        const pinnedProvider = versionMap['18.3.1'];
        pinnedProvider.from = 'remote';
        pinnedProvider.lib = factory;
        pinnedProvider.loaded = true;
        return factory;
      },
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

  it('clears a rejected pinned runtime load so it can retry', async () => {
    const get = vi
      .fn<() => Promise<() => unknown>>()
      .mockRejectedValueOnce(new Error('broken runtime provider'))
      .mockResolvedValueOnce(() => ({ marker: 'host-react' }));
    const versionMap: Record<string, RuntimeBridgeProvider> = {
      '18.3.1': { from: 'host', get },
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
    expect(versionMap['18.3.1'].loading).toBeUndefined();

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

  it('uses the runtime resolve hook for external provider selection', async () => {
    const selectProvider = await getExternalSharedProviderSelector();
    const pluginProvider = { from: 'plugin-provider', lib: () => ({ marker: 'plugin' }) };
    const defaultProvider = { from: 'default-provider', lib: () => ({ marker: 'default' }) };
    const localProvider = {
      from: 'remote',
      version: '3.0.0',
      shareConfig: { singleton: true, requiredVersion: '*' },
    };
    const resolveShareHook = {
      emit: (params: any) => ({
        ...params,
        resolver: () => ({
          shared: params.shareScopeMap.default.react['1.0.0'],
          useTreesShaking: false,
        }),
      }),
    };

    expect(
      selectProvider(
        {
          '1.0.0': pluginProvider,
          '2.0.0': defaultProvider,
        },
        'react',
        localProvider,
        'version-first',
        resolveShareHook
      )
    ).toBe(pluginProvider);
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
      'for (const [pkg, versionMap] of Object.entries(globalVersionsByPackage))'
    );
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
