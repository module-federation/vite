import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasPackageDependencyMock, writeSyncSpy, writeTempSpy } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn(),
  writeSyncSpy: vi.fn(),
  writeTempSpy: vi.fn(),
}));

vi.mock('../../utils/VirtualModule', () => {
  return {
    default: class MockVirtualModule {
      name: string;

      constructor(name: string) {
        this.name = name;
      }

      getPath() {
        return `/virtual/${this.name}.js`;
      }

      getImportId() {
        return `virtual:${this.name}`;
      }

      writeSync = writeSyncSpy;
    },
  };
});

vi.mock('../../utils/localSharedImportMap_temp', () => {
  return {
    getLocalSharedImportMapPath_temp: () => '/virtual/localSharedImportMap.js',
    writeLocalSharedImportMap_temp: writeTempSpy,
  };
});

vi.mock('../../utils/packageUtils', () => {
  return {
    hasPackageDependency: hasPackageDependencyMock,
  };
});

vi.mock('../../utils/normalizeModuleFederationOptions', () => {
  return {
    getNormalizeModuleFederationOptions: () => ({
      name: 'host',
      filename: 'remoteEntry.js',
      remotes: {},
      shareScope: 'default',
      runtimePlugins: [],
      shareStrategy: 'version-first',
    }),
    getNormalizeShareItem: (pkg: string) => ({
      name: pkg,
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        import: pkg === 'custom-import' ? '/abs/custom-import.js' : undefined,
        singleton: true,
        requiredVersion: '^19.2.4',
        strictVersion: false,
      },
    }),
  };
});

vi.mock('../virtualRemotes', () => {
  return {
    getUsedRemotesMap: () => ({}),
  };
});

vi.mock('../virtualShared_preBuild', () => {
  return {
    getPreBuildLibImportId: (pkg: string) => `virtual:prebuild:${pkg}`,
    getLocalProviderImportPath: () => undefined,
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
    writeSyncSpy.mockClear();
    writeTempSpy.mockClear();
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

  it('writes host auto init waiting on __tla before init', async () => {
    hasPackageDependencyMock.mockImplementation((pkg: string) => {
      return pkg === 'vinext';
    });

    const mod = await import('../virtualRemoteEntry');

    mod.writeHostAutoInit('virtual:test-remote-entry');

    expect(writeSyncSpy).toHaveBeenCalled();
    const generatedCode = writeSyncSpy.mock.calls.at(-1)?.[0] as string;

    expect(generatedCode).toContain(
      'const remoteEntry = await import("virtual:test-remote-entry");'
    );
    expect(generatedCode).toContain('await remoteEntry.init();');
    expect(generatedCode).not.toContain('Promise.resolve(remoteEntry.__tla)');
    expect(generatedCode).not.toContain('.then(remoteEntry.init)');
    expect(generatedCode).not.toContain('.catch(remoteEntry.init)');
  });

  it('inlines a dedicated build-only initResolve bootstrap into remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
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

  it('loads local shared state and exposes lazily inside remoteEntry', async () => {
    const mod = await import('../virtualRemoteEntry');

    const code = mod.generateRemoteEntry(
      {
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
      'localSharedImportMapPromise ??= import("/virtual/localSharedImportMap.js")'
    );
    expect(code).toContain(
      'exposesMapPromise ??= import("virtual:exposes").then((mod) => mod.default ?? mod)'
    );
    expect(code).toContain('const {usedShared, usedRemotes} = await getLocalSharedImportMap()');
    expect(code).toContain('const exposesMap = await getExposesMap()');
    expect(code).not.toContain('import exposesMap from');
    expect(code).not.toContain('import {usedShared, usedRemotes} from');
  });
});
