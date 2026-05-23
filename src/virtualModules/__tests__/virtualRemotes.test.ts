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
    expect(code).toContain('exportModule = await __mfRemotePending;');
    expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
  });

  it('defers browser remote loading until use for loaded-first', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain('runtime.registerRemotes([');
    expect(code).toContain('typeof window === "undefined"');
    expect(code).not.toContain('__mfReact');
    expect(code).not.toMatch(
      /typeof window === "undefined"[\s\S]*?} else \{\s*__mfRemotePending = __mfStartRemoteLoad\(\)/
    );
  });

  it('awaits the real remote on the server for loaded-first dev', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('if (typeof window === "undefined")');
    expect(code).toContain('exportModule = await __mfRemotePending;');
  });

  it('does not use a React-specific remote proxy', () => {
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

  it('uses build remote wrappers with unified remote resolution', () => {
    const code = generateRemotes('remote/App', 'build');

    expect(code).toContain('exportModule = await __mfRemotePending;');
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain('__mfRemotePending ??= __mfStartRemoteLoad();');
    expect(code).toContain('__mfRemotePending = __mfStartRemoteLoad();');
    expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
    expect(code).toContain('__mfUnwrapRemoteDefault(exportModule)');
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
  });
});
