import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_ENV_GUARD } from '../../utils/ssrCapabilities';
import { getRemoteVirtualModule, generateRemotes, resolveRemoteInitMode } from '../virtualRemotes';

const mockOptions = vi.hoisted(() => ({
  shareStrategy: 'version-first' as 'version-first' | 'loaded-first',
}));
const hasPackageDependencyMock = vi.hoisted(() => vi.fn((_pkg: string) => false));

vi.mock('../../utils/packageUtils', async () => {
  const actual = await vi.importActual<typeof import('../../utils/packageUtils')>(
    '../../utils/packageUtils'
  );
  return {
    ...actual,
    hasPackageDependency: hasPackageDependencyMock,
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
      alias: {
        entryGlobalName: 'remote_alias',
        name: 'remote-container',
        type: 'module',
        entry: 'http://localhost:4177/remoteEntry.js',
        shareScope: 'default',
      },
    },
    shareStrategy: mockOptions.shareStrategy,
    virtualModuleDir: '__mf__virtual',
  }),
}));

function runGeneratedRemoteModule(
  code: string,
  runtime: { loadRemote: ReturnType<typeof vi.fn>; registerRemotes?: ReturnType<typeof vi.fn> }
) {
  const start = code.indexOf('function __mfStartRemoteLoad()');
  expect(start).toBeGreaterThanOrEqual(0);

  const moduleCode = code
    .slice(start)
    // The Function-based harness runs outside Vite's ESM transform. Model the
    // client environment that these assertions exercise.
    .replaceAll('import.meta.env.SSR', 'false')
    .replace(
      'export { exportModule as __moduleExports };',
      'Object.defineProperty(__exports, "__moduleExports", { enumerable: true, get: () => exportModule });'
    )
    .replace('export const __mf_remote_pending =', 'const __mf_remote_pending =')
    .replace('export function then', 'function then')
    .replace(
      'export { __mfDefaultExport as default };',
      'Object.defineProperty(__exports, "default", { enumerable: true, get: () => __mfDefaultExport });'
    )
    .replace('export default __mfDefaultExport', '__exports.default = __mfDefaultExport');

  return Function(
    'runtime',
    `
      const __exports = {};
      const __mfModuleCache = { remote: {}, share: {} };
      const initPromise = Promise.resolve(runtime);
      const __mfHostInitPromise = initPromise;
      ${moduleCode}
      Object.defineProperty(__exports, "__mf_remote_pending", {
        enumerable: true,
        get: () => __mf_remote_pending,
      });
      return __exports;
    `
  )(runtime) as {
    default: unknown;
    __moduleExports: Record<string, unknown>;
    __mf_remote_pending: Promise<unknown> | { then: Promise<unknown>['then'] };
  };
}

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
  it('uses distinct virtual ids for client and server environment graphs', () => {
    const client = getRemoteVirtualModule('remote/environment-split', 'serve', true, 'client');
    const server = getRemoteVirtualModule('remote/environment-split', 'serve', true, 'server');

    expect(client.getImportId()).not.toBe(server.getImportId());
    expect(client.code).toContain('hostInitPromise');
    expect(server.code).not.toContain('.then(initResolve, initReject)');
  });
  beforeEach(() => {
    mockOptions.shareStrategy = 'version-first';
    hasPackageDependencyMock.mockReset();
    hasPackageDependencyMock.mockReturnValue(false);
  });

  it('split client wrapper with SSR init starts loading and keeps a stable proxy', () => {
    const code = generateRemotes('remote/Button', 'serve', true, 'client');

    expect(code).toContain('__mfAssignRemoteModule');
    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain(
      '__mfRemotePending = __mfStartRemoteLoad().then(__mfAssignRemoteModule)'
    );
    expect(code).toContain('import("/virtual/hostInit.js")');
    expect(code).not.toContain('await ');
  });

  it('keeps deferred client proxies on build when SSR init is enabled', () => {
    const code = generateRemotes('remote/Button', 'build', true);

    expect(code).toContain(SERVER_ENV_GUARD);
    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain('__mfStartRemoteLoad().then(__mfAssignRemoteModule)');
    expect(code).not.toContain('await ');
  });

  it('split server wrapper with SSR init bootstraps host init on the server only', () => {
    const code = generateRemotes('remote/Button', 'serve', true, 'server');

    expect(code).toContain(SERVER_ENV_GUARD);
    expect(code).toContain('import("/virtual/hostInit.js")');
    expect(code).not.toMatch(
      /import\("\/virtual\/hostInit\.js"\)\s*\n\s*\.then\(\(mod\) => mod\.hostInitPromise\)\s*\n\s*\.then\(initResolve, initReject\)/
    );
  });

  it('starts remote loading during wrapper evaluation for version-first', () => {
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain(SERVER_ENV_GUARD);
    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain('runtime.loadRemote("remote/Button")');
    expect(code).toContain('__mfAssignRemoteModule');
    expect(code).toContain('__mfSyncDefaultExport');
    expect(code).not.toContain('await ');
    expect(code).not.toContain('__mfCreateRemoteProxy');
  });

  it('keeps default-only imports live until the remote resolves', async () => {
    const remoteDefault = { kind: 'default' };
    const runtime = {
      loadRemote: vi.fn(() => Promise.resolve({ default: remoteDefault, named: 'ready' })),
    };
    const exports = runGeneratedRemoteModule(
      generateRemotes('remote/Button', 'serve', true, 'server'),
      runtime
    );

    expect(exports.default).toBeUndefined();

    await exports.__mf_remote_pending;

    expect(runtime.loadRemote).toHaveBeenCalledWith('remote/Button');
    expect(exports.default).toBe(remoteDefault);
  });

  it('resolves named imports in SSR dev after remote dependency pending settles', async () => {
    const remoteModule = { default: 'default', named: 'named-value' };
    const runtime = {
      loadRemote: vi.fn(() => Promise.resolve(remoteModule)),
    };
    const exports = runGeneratedRemoteModule(
      generateRemotes('remote/Button', 'serve', true, 'server'),
      runtime
    );

    await exports.__mf_remote_pending;

    expect(exports.__moduleExports.named).toBe('named-value');
    expect(exports.__moduleExports).toBe(remoteModule);
  });

  it('rejects remote pending when dev loadRemote fails', async () => {
    const loadError = new Error('remote failed');
    const runtime = {
      loadRemote: vi.fn(() => Promise.reject(loadError)),
    };
    const exports = runGeneratedRemoteModule(generateRemotes('remote/Button', 'serve'), runtime);

    await expect(Promise.resolve(exports.__mf_remote_pending)).rejects.toBe(loadError);
    expect(runtime.loadRemote).toHaveBeenCalledWith('remote/Button');
  });

  it('defers browser remote loading until use for loaded-first (non-React)', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain('runtime.registerRemotes([');
    expect(code).toContain(SERVER_ENV_GUARD);
    expect(code).not.toContain('__mfReact');
    expect(code).not.toContain('__mfCreateRemoteProxy');
    expect(code).not.toMatch(
      /process\.versions\.node[\s\S]*?} else \{\s*__mfRemotePending = __mfStartRemoteLoad\(\)/
    );
    expect(code).not.toContain('Promise.resolve(exportModule)');
    expect(code).toContain('export const __mf_remote_pending = __mfRemotePending ?? {');
    expect(code).toContain(
      '__mfRemotePending ??= __mfStartRemoteLoad().then(__mfAssignRemoteModule)'
    );
  });

  it('resolves the real remote on the server for loaded-first dev', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain(`if (${SERVER_ENV_GUARD})`);
    expect(code).toContain('__mfAssignRemoteModule');
    expect(code).not.toContain('await ');
  });

  describe('environment-split wrappers (loaded-first dev)', () => {
    beforeEach(() => {
      mockOptions.shareStrategy = 'loaded-first';
    });

    it('client wrapper uses proxy without typeof window', () => {
      const code = generateRemotes('remote/Button', 'serve', false, 'client');

      expect(code).toContain('__mfCreateDeferredRemoteProxy()');
      expect(code).not.toContain(SERVER_ENV_GUARD);
      expect(code).toContain('import("/virtual/hostInit.js")');
      expect(code).not.toContain('await ');
      expect(code).not.toContain('Promise.resolve(exportModule)');
      expect(code).toContain('export const __mf_remote_pending = __mfRemotePending ?? {');
    });

    it('server wrapper resolves the real remote without proxy helpers', () => {
      const code = generateRemotes('remote/Button', 'serve', false, 'server');

      expect(code).toContain('__mfAssignRemoteModule');
      expect(code).not.toContain('await ');
      expect(code).not.toContain(SERVER_ENV_GUARD);
      expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
      expect(code).not.toContain('import("/virtual/hostInit.js")');
    });

    it('client wrapper stays lazy when React is installed', () => {
      hasPackageDependencyMock.mockReturnValue(true);

      const code = generateRemotes('remote/Button', 'serve', false, 'client');

      expect(code).toContain('exportModule = __mfCreateDeferredRemoteProxy();');
      expect(code).not.toContain('__mfRemotePending = __mfStartRemoteLoad();');
      expect(code).not.toContain('__mfCreateRemoteProxy');
      expect(code).not.toContain('__mfReact');
      expect(code).not.toContain(SERVER_ENV_GUARD);
    });
  });

  it('defers remote loading when React is installed for loaded-first', () => {
    hasPackageDependencyMock.mockReturnValue(true);

    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('remote/Button', 'serve');

    expect(code).toContain('exportModule = __mfCreateDeferredRemoteProxy();');
    expect(code).toContain('pendingPromise ||= __mfStartRemoteLoad();');
    expect(code).toContain('runtime.registerRemotes([');
    expect(code).not.toMatch(
      /process\.versions\.node[\s\S]*?} else \{\s*__mfRemotePending = __mfStartRemoteLoad\(\)/
    );
    expect(code).not.toContain('__mfCreateRemoteProxy');
    expect(code).not.toContain('__mfReact');
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

  it('registers the consumer alias separately from the remote container name', () => {
    mockOptions.shareStrategy = 'loaded-first';
    const code = generateRemotes('alias/Button', 'serve');

    expect(code).toContain('"name":"remote-container"');
    expect(code).toContain('"alias":"alias"');
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

    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).not.toContain('await ');
    expect(code).toContain(
      '.then((mod) => Promise.resolve(mod?.__mf_remote_dependency_pending).then(() => mod))'
    );
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain('export { __mfDefaultExport as default };');
    expect(code).toContain('export const __mf_remote_pending =');
    expect(code).not.toContain('module.exports = exportModule');
  });

  it('starts host init for dev remote wrappers', () => {
    const code = generateRemotes('remote/Button', 'serve');

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

    expect(code).toContain(SERVER_ENV_GUARD);
    expect(code).toContain('__mfCreateDeferredRemoteProxy()');
    expect(code).toContain('__mfAssignRemoteModule');
    expect(code).not.toContain('await ');
    expect(code).toContain('export { exportModule as __moduleExports };');
    expect(code).toContain('export { __mfDefaultExport as default };');
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
      expect(code).not.toContain('await ');
      expect(code).toContain('export const __mf_remote_pending = __mfRemotePending ?? {');
    });

    it('resolves the real remote for SSR build output', () => {
      const code = generateRemotes('remote/App', 'build', false, 'server');

      expect(code).toContain(
        '__mfRemotePending = __mfStartRemoteLoad().then(__mfAssignRemoteModule)'
      );
      expect(code).not.toContain('await ');
      expect(code).not.toContain('__mfCreateDeferredRemoteProxy');
    });

    it('unified build keeps browser deferral and SSR promise chain via the Node guard', () => {
      const code = generateRemotes('remote/App', 'build');

      expect(code).toContain(SERVER_ENV_GUARD);
      expect(code).toContain('__mfCreateDeferredRemoteProxy()');
      expect(code).toContain('__mfAssignRemoteModule');
      expect(code).not.toContain('await ');
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

  it('scopes wrappers and generated remote entries to explicit plugin options', () => {
    const optionsA = {
      internalName: 'host_a',
      shareStrategy: 'loaded-first',
      remotes: {
        remote: {
          entryGlobalName: 'remote_a',
          name: 'remote-a',
          type: 'module',
          entry: 'https://tenant-a.invalid/remoteEntry.js',
          shareScope: 'default',
        },
      },
    } as never;
    const optionsB = {
      internalName: 'host_b',
      shareStrategy: 'loaded-first',
      remotes: {
        remote: {
          entryGlobalName: 'remote_b',
          name: 'remote-b',
          type: 'module',
          entry: 'https://tenant-b.invalid/remoteEntry.js',
          shareScope: 'default',
        },
      },
    } as never;

    const wrapperA = getRemoteVirtualModule('remote/Card', 'serve', false, 'client', optionsA);
    const wrapperB = getRemoteVirtualModule('remote/Card', 'serve', false, 'client', optionsB);

    expect(wrapperA).not.toBe(wrapperB);
    expect(wrapperA.getImportId()).toContain('host_a');
    expect(wrapperB.getImportId()).toContain('host_b');
    expect(wrapperA.code).toContain('https://tenant-a.invalid/remoteEntry.js');
    expect(wrapperA.code).not.toContain('https://tenant-b.invalid/remoteEntry.js');
    expect(wrapperB.code).toContain('https://tenant-b.invalid/remoteEntry.js');
    expect(wrapperB.code).not.toContain('https://tenant-a.invalid/remoteEntry.js');
  });

  it('uses ESM remote wrappers in Rollup build mode', () => {
    const virtual = getRemoteVirtualModule('remote/Card', 'build');

    expect(virtual.getImportId()).toContain('.js');
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
