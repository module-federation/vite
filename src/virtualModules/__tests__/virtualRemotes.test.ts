import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRemoteVirtualModule, generateRemotes } from '../virtualRemotes';

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

describe('generateRemotes', () => {
  beforeEach(() => {
    mockOptions.shareStrategy = 'version-first';
  });

  it('starts remote loading during wrapper evaluation for version-first', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('__mfRemotePending = __mfStartRemoteLoad();');
    expect(code).toContain('runtime.loadRemote("remote/Button")');
  });

  it('defers remote loading until proxy use for loaded-first', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('exportModule = __mfCreateRemoteProxy();');
    expect(code).toContain('pendingPromise ||= __mfStartRemoteLoad();');
    expect(code).toContain('runtime.registerRemotes([');
    expect(code).not.toContain('__mfRemotePending = __mfStartRemoteLoad();');
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

    // The remote name contains a slash, so it must be matched against the
    // configured remotes rather than naively split on the first path segment.
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

  it('uses ESM remote wrapper exports in dev', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).not.toContain('await __mfRemotePending');
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain(
      'export const __mf_remote_pending = __mfRemotePending || Promise.resolve(exportModule);'
    );
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

  it('awaits build remote loading before exporting the module', () => {
    const code = generateRemotes('remote/App', 'build');

    expect(code).not.toContain('await __mfRemotePending');
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain(
      'export const __mf_remote_pending = __mfRemotePending || Promise.resolve(exportModule);'
    );
    expect(code).toContain('exportModule = __mfCreateRemoteProxy(__mfRemotePending);');
    expect(code).toContain(
      'export default exportModule?.__mf_is_remote_proxy ? exportModule : exportModule?.__esModule ? exportModule.default : exportModule.default ?? exportModule'
    );
  });

  it('uses ESM remote wrappers in Rollup build mode', () => {
    const virtual = getRemoteVirtualModule('remote/Card', 'build');

    expect(virtual.getImportId()).toContain('.mjs');
  });

  describe('proxy invariants', () => {
    it('ownKeys includes non-configurable target keys', () => {
      const code = generateRemotes('remote/Proxy', 'serve');

      // The ownKeys trap must include non-configurable target own keys to satisfy the Proxy invariant
      expect(code).toContain('Reflect.ownKeys(proxyTarget)');
      expect(code).toContain('!d.configurable');
      expect(code).toContain('keys.add(k)');
    });

    it('getOwnPropertyDescriptor returns target descriptor for non-configurable props', () => {
      const code = generateRemotes('remote/Proxy', 'serve');

      // The getOwnPropertyDescriptor trap must report non-configurable target props accurately
      expect(code).toContain('getOwnPropertyDescriptor(_target, prop)');
      expect(code).toContain('Object.getOwnPropertyDescriptor(proxyTarget, prop)');
      expect(code).toContain('if (targetDesc && !targetDesc.configurable) return targetDesc;');
    });

    it('proxy still delegates property access to the remote module', () => {
      const code = generateRemotes('remote/Proxy', 'serve');

      // The get trap should proxy properties to the loaded module
      expect(code).toContain('const mod = getModule();');
      expect(code).toContain('return prop in mod ? mod[prop] : mod.default?.[prop];');
    });
  });
});
