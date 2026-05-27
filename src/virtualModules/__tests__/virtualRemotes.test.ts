import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRemoteVirtualModule, generateRemotes, resolveRemoteInitMode } from '../virtualRemotes';

const mockOptions = vi.hoisted(() => ({
  shareStrategy: 'version-first' as 'version-first' | 'loaded-first',
}));

vi.mock('../../utils/packageUtils', async () => {
  const actual = await vi.importActual<typeof import('../../utils/packageUtils')>(
    '../../utils/packageUtils'
  );
  return {
    ...actual,
    hasPackageDependency: vi.fn(() => false),
  };
});

vi.mock('../virtualRemoteEntry', () => ({
  getHostAutoInitPath: () => '/virtual/hostInit.js',
}));

vi.mock('../../utils/normalizeModuleFederationOptions', () => ({
  getNormalizeModuleFederationOptions: () => ({
    internalName: 'host',
    remotes: {
      remote: {
        entryGlobalName: 'remote',
        name: 'remote',
        type: 'module',
        entry: 'http://localhost:4174/remoteEntry.js',
        shareScope: 'default',
      },
      'remote/sub': {
        entryGlobalName: 'remote_sub',
        name: 'remote/sub',
        type: 'module',
        entry: 'http://localhost:4176/remoteEntry.js',
        shareScope: 'default',
      },
      '@scope/remote': {
        entryGlobalName: 'scope_remote',
        name: '@scope/remote',
        type: 'module',
        entry: 'http://localhost:4175/remoteEntry.js',
        shareScope: 'default',
      },
    },
    shareStrategy: mockOptions.shareStrategy,
    virtualModuleDir: '__mf__virtual',
  }),
}));

describe('resolveRemoteInitMode', () => {
  it.each([
    ['version-first', 'unified', 'eager'],
    ['version-first', 'client', 'eager'],
    ['version-first', 'server', 'eager'],
    ['loaded-first', 'client', 'loaded-first-client'],
    ['loaded-first', 'server', 'loaded-first-ssr'],
    ['loaded-first', 'unified', 'loaded-first-unified'],
  ] as const)('maps %s + %s to %s', (shareStrategy, consumer, expected) => {
    expect(resolveRemoteInitMode(shareStrategy, consumer)).toBe(expected);
  });
});

describe('generateRemotes', () => {
  beforeEach(async () => {
    mockOptions.shareStrategy = 'version-first';
    const { hasPackageDependency } = await import('../../utils/packageUtils');
    vi.mocked(hasPackageDependency).mockReturnValue(false);
  });

  it('starts remote loading during wrapper evaluation for version-first', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('__mfRemotePending = __mfStartRemoteLoad();');
    expect(code).toContain('runtime.loadRemote("remote/Button")');
    expect(code).toContain('exportModule = await __mfRemotePending;');
    expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
    expect(code).not.toContain('__mfCreateRemoteProxy');
  });

  it('defers browser remote loading until use for loaded-first (non-React)', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain('runtime.registerRemotes([');
    expect(code).toContain('typeof window === "undefined"');
    expect(code).not.toContain('__mfReact');
    expect(code).not.toContain('__mfCreateRemoteProxy');
    expect(code).not.toMatch(
      /typeof window === "undefined"[\s\S]*?} else \{\s*__mfRemotePending = __mfStartRemoteLoad\(\)/
    );
    expect(code).not.toContain('Promise.resolve(exportModule)');
    expect(code).toContain('export const __mf_remote_pending = __mfRemotePending ?? {');
    expect(code).toContain('__mfRemotePending ??= __mfStartRemoteLoad().then((mod) => {');
  });

  it('awaits the real remote on the server for loaded-first dev', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('if (typeof window === "undefined")');
    expect(code).toContain('exportModule = await __mfRemotePending;');
  });

  describe('environment-split wrappers (loaded-first dev)', () => {
    beforeEach(() => {
      mockOptions.shareStrategy = 'loaded-first';
    });

    it('client wrapper uses proxy without typeof window', () => {
      const code = generateRemotes('remote/Button', 'serve', false, 'client');

      expect(code).toContain('__mfCreateDeferredRemoteProxy()');
      expect(code).not.toContain('typeof window === "undefined"');
      expect(code).toContain('import("/virtual/hostInit.js")');
      expect(code).not.toContain('exportModule = await __mfRemotePending;');
      expect(code).not.toContain('Promise.resolve(exportModule)');
      expect(code).toContain('export const __mf_remote_pending = __mfRemotePending ?? {');
    });

    it('server wrapper awaits the real remote without proxy helpers', () => {
      const code = generateRemotes('remote/Button', 'serve', false, 'server');

      expect(code).toContain('exportModule = await __mfRemotePending;');
      expect(code).not.toContain('typeof window === "undefined"');
      expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
      expect(code).not.toContain('import("/virtual/hostInit.js")');
    });

    it('client React wrapper starts load and exposes a proxy', async () => {
      const { hasPackageDependency } = await import('../../utils/packageUtils');
      vi.mocked(hasPackageDependency).mockReturnValue(true);

      const code = generateRemotes('remote/Button', 'serve', false, 'client');

      expect(code).toContain('exportModule = __mfCreateRemoteProxy(__mfRemotePending);');
      expect(code).not.toContain('typeof window === "undefined"');
    });
  });

  it('starts remote loading while keeping a React proxy for loaded-first', async () => {
    const { hasPackageDependency } = await import('../../utils/packageUtils');
    vi.mocked(hasPackageDependency).mockReturnValue(true);

    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('exportModule = __mfCreateRemoteProxy(__mfRemotePending);');
    expect(code).toContain('pendingPromise ||= __mfStartRemoteLoad();');
    expect(code).toContain('runtime.registerRemotes([');
    expect(code).toContain('__mfRemotePending = __mfStartRemoteLoad();');
    expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
  });

  it('loads a scoped remote module using its full id', () => {
    const code = generateRemotes('@scope/remote/Button', 'serve');

    expect(code).toContain('runtime.loadRemote("@scope/remote/Button")');
  });

  it('loads a scoped remote referenced by its bare name', () => {
    const code = generateRemotes('@scope/remote', 'serve');

    expect(code).toContain('runtime.loadRemote("@scope/remote")');
  });

  it('registers the scoped remote config for loaded-first', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('@scope/remote/Button', 'serve');

    expect(code).toContain('runtime.registerRemotes([');
    expect(code).toContain('"name":"@scope/remote"');
    expect(code).toContain('"entryGlobalName":"scope_remote"');
    expect(code).toContain('"entry":"http://localhost:4175/remoteEntry.js"');
  });

  it('skips remote registration when a scoped id matches no configured remote', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('@scope/unknown/Button', 'serve');

    expect(code).not.toContain('runtime.registerRemotes([');
    expect(code).toContain('runtime.loadRemote("@scope/unknown/Button")');
  });

  it('uses the most specific remote config when names overlap', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/sub/Button', 'serve');

    expect(code).toContain('runtime.registerRemotes([');
    expect(code).toContain('"name":"remote/sub"');
    expect(code).toContain('"entryGlobalName":"remote_sub"');
    expect(code).toContain('"entry":"http://localhost:4176/remoteEntry.js"');
  });

  it('does not use a React-specific remote proxy when React is absent', () => {
    const code = generateRemotes('remote/Button', 'serve', true);

    expect(code).not.toContain('__mfCreateRemoteProxy');
    expect(code).not.toContain('__mfReact');
  });

  it('uses ESM remote wrapper exports in dev', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('exportModule = await __mfRemotePending;');
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain('__mfRemotePending ??= __mfStartRemoteLoad();');
    expect(code).not.toContain('module.exports = exportModule');
  });

  it('starts host init for browser dev remote wrappers', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('if (typeof window !== "undefined")');
    expect(code).toContain('import("/virtual/hostInit.js")');
    expect(code).toContain('.then((mod) => mod.hostInitPromise)');
    expect(code).toContain('.then(initResolve, initReject)');
  });

  it('can include SSR runtime init in dev wrappers', () => {
    const code = generateRemotes('remote/Button', 'serve', true);

    expect(code).toContain("import(/* @vite-ignore */ '@module-federation/vite/ssrEntryLoader')");
    expect(code).toContain('initResolve(runtime)');
  });

  it('uses build remote wrappers with unified remote resolution (version-first)', () => {
    const code = generateRemotes('remote/App', 'build');

    expect(code).toContain('exportModule = await __mfRemotePending;');
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain('__mfRemotePending ??= __mfStartRemoteLoad();');
    expect(code).toContain('__mfRemotePending = __mfStartRemoteLoad();');
    expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
    expect(code).not.toContain('__mfCreateRemoteProxy');
    expect(code).toContain('__mfUnwrapRemoteDefault(exportModule)');
  });

  describe('loaded-first build', () => {
    beforeEach(() => {
      mockOptions.shareStrategy = 'loaded-first';
    });

    it('defers client build remotes until an export is read', () => {
      const code = generateRemotes('remote/App', 'build', false, 'client');

      expect(code).toContain('__mfCreateDeferredRemoteProxy()');
      expect(code).not.toContain('__mfRemotePending = __mfStartRemoteLoad();');
      expect(code).not.toContain('exportModule = await __mfRemotePending;');
      expect(code).toContain('export const __mf_remote_pending = __mfRemotePending ?? {');
    });

    it('awaits the real remote for SSR build output', () => {
      const code = generateRemotes('remote/App', 'build', false, 'server');

      expect(code).toContain('__mfRemotePending = __mfStartRemoteLoad();');
      expect(code).toContain('exportModule = await __mfRemotePending;');
      expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
    });

    it('unified build keeps browser deferral and SSR await via typeof window', () => {
      const code = generateRemotes('remote/App', 'build');

      expect(code).toContain('typeof window === "undefined"');
      expect(code).toContain('__mfCreateDeferredRemoteProxy()');
      expect(code).toContain('exportModule = await __mfRemotePending;');
    });
  });

  it('caches client and server build wrappers separately', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const client = getRemoteVirtualModule('remote/Card', 'build', false, 'client');
    const server = getRemoteVirtualModule('remote/Card', 'build', false, 'server');

    expect(client).not.toBe(server);
    expect(client.code).toContain('__mfCreateDeferredRemoteProxy');
    expect(server.code).not.toContain('__mfCreateDeferredRemoteProxy');
  });

  it('uses ESM remote wrappers in Rollup build mode', () => {
    const virtual = getRemoteVirtualModule('remote/Card', 'build');

    expect(virtual.getImportId()).toContain('.mjs');
  });

  describe('deferred proxy invariants', () => {
    it('ownKeys includes non-configurable target keys', () => {
      mockOptions.shareStrategy = 'loaded-first';
      const code = generateRemotes('remote/Proxy', 'serve');

      expect(code).toContain('Reflect.ownKeys(proxyTarget)');
      expect(code).toContain('!d.configurable');
      expect(code).toContain('keys.add(k)');
    });

    it('getOwnPropertyDescriptor returns target descriptor for non-configurable props', () => {
      mockOptions.shareStrategy = 'loaded-first';
      const code = generateRemotes('remote/Proxy', 'serve');

      expect(code).toContain('getOwnPropertyDescriptor(_target, prop)');
      expect(code).toContain('Object.getOwnPropertyDescriptor(proxyTarget, prop)');
      expect(code).toContain('if (targetDesc && !targetDesc.configurable) return targetDesc;');
    });

    it('proxy still delegates property access to the remote module', () => {
      mockOptions.shareStrategy = 'loaded-first';
      const code = generateRemotes('remote/Proxy', 'serve');

      expect(code).toContain('const mod = getModule();');
      expect(code).toContain('return prop in mod ? mod[prop] : mod.default?.[prop];');
    });
  });
});
