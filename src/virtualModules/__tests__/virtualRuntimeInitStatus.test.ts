import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeSyncSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
}));

vi.mock('../../utils/VirtualModule', () => ({
  MF_OWNER_INFIX: '__mf_owner__',
  default: class MockVirtualModule {
    getImportId() {
      return 'virtual:runtimeInit';
    }
    writeSync = writeSyncSpy;
  },
}));

function runCode<T>(code: string, returnStatement: string): T {
  return Function(`${code}\n${returnStatement}`)() as T;
}

describe('virtualRuntimeInitStatus', () => {
  beforeEach(() => {
    writeSyncSpy.mockClear();
    delete (globalThis as Record<string, unknown>)['__mf_module_cache__'];
    delete (globalThis as Record<string, unknown>)['__mf_module_cache_react_server__'];
    delete (globalThis as Record<string, unknown>)['__mf_init__virtual:runtimeInit__'];
  });

  it('uses a deterministic runtime init global key scoped by virtual import id', async () => {
    const { getRuntimeInitGlobalKey } = await import('../virtualRuntimeInitStatus');

    expect(getRuntimeInitGlobalKey()).toBe('__mf_init__virtual:runtimeInit__');
  });

  it('initializes module cache bootstrap without replacing existing share and remote maps', async () => {
    const { getRuntimeModuleCacheBootstrapCode } = await import('../virtualRuntimeInitStatus');
    const share = { react: { loaded: true } };
    const remote = { app: { loaded: true } };
    (globalThis as any).__mf_module_cache__ = { share, remote };

    const cache = runCode<any>(
      getRuntimeModuleCacheBootstrapCode(),
      'return { cache: __mfModuleCache, share: __mfModuleCache.share, remote: __mfModuleCache.remote };'
    );

    expect(cache.cache).toBe((globalThis as any).__mf_module_cache__);
    expect(cache.share).toBe(share);
    expect(cache.remote).toBe(remote);
  });

  it('isolates the react-server module cache', async () => {
    const { getModuleCacheGlobalKey } = await import('../virtualRuntimeInitStatus');

    expect(getModuleCacheGlobalKey()).toBe('__mf_module_cache__');
    expect(getModuleCacheGlobalKey(['react-server', 'node'])).toBe(
      '__mf_module_cache_react_server__'
    );
  });

  it('selects the current environment cache for an existing owner', async () => {
    const { getRuntimeInitBootstrapCode } = await import('../virtualRuntimeInitStatus');
    const owner = 'virtual:owner';
    const run = (conditions?: string[]) =>
      runCode<any>(
        getRuntimeInitBootstrapCode(false, owner, undefined, owner, conditions),
        'return globalThis[globalKey].moduleCache;'
      );

    const ssrCache = run(['node']);
    const reactServerCache = run(['react-server', 'node']);

    expect(reactServerCache).not.toBe(ssrCache);
    expect(reactServerCache).toBe((globalThis as any).__mf_module_cache_react_server__);
    delete (globalThis as any)['__mf_init__virtual:owner__'];
  });

  it('cleans settled loads in default and react-server caches without changing the original promises', async () => {
    const { getRuntimeModuleCacheBootstrapCode } = await import('../virtualRuntimeInitStatus');
    const defaultTracker = runCode<(promise: Promise<unknown>) => Promise<unknown>>(
      getRuntimeModuleCacheBootstrapCode(),
      'return __mfTrackPendingShareLoad;'
    );
    const reactServerTracker = runCode<(promise: Promise<unknown>) => Promise<unknown>>(
      getRuntimeModuleCacheBootstrapCode(['react-server', 'node']),
      'return __mfTrackPendingShareLoad;'
    );
    const defaultCache = (globalThis as any).__mf_module_cache__;
    const reactServerCache = (globalThis as any).__mf_module_cache_react_server__;
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    let resolveReactServer!: () => void;
    const first = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const reactServer = new Promise<void>((resolve) => {
      resolveReactServer = resolve;
    });

    expect(defaultCache.pendingShareLoads).toBeUndefined();
    expect(reactServerCache.pendingShareLoads).toBeUndefined();
    expect(defaultTracker(first)).toBe(first);
    expect(defaultTracker(second)).toBe(second);
    expect(reactServerTracker(reactServer)).toBe(reactServer);
    expect(defaultCache.pendingShareLoads).toEqual([first, second]);
    expect(reactServerCache.pendingShareLoads).toEqual([reactServer]);

    const defaultWaiter = Promise.all(defaultCache.pendingShareLoads);
    const reactServerWaiter = Promise.all(reactServerCache.pendingShareLoads);
    const firstError = new Error('default shared load failed');
    rejectFirst(firstError);
    await expect(defaultWaiter).rejects.toBe(firstError);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(defaultCache.pendingShareLoads).toEqual([second]);
    expect(reactServerCache.pendingShareLoads).toEqual([reactServer]);

    resolveSecond();
    resolveReactServer();
    await expect(second).resolves.toBeUndefined();
    await expect(reactServerWaiter).resolves.toEqual([undefined]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(defaultCache.pendingShareLoads).toEqual([]);
    expect(reactServerCache.pendingShareLoads).toEqual([]);
  });

  it('does not let rejected-load cleanup remove a newer retry in the same cache', async () => {
    const { getRuntimeModuleCacheBootstrapCode } = await import('../virtualRuntimeInitStatus');
    const tracker = runCode<(promise: Promise<unknown>) => Promise<unknown>>(
      getRuntimeModuleCacheBootstrapCode(),
      'return __mfTrackPendingShareLoad;'
    );
    const cache = (globalThis as any).__mf_module_cache__;
    let rejectFirst!: (error: Error) => void;
    let resolveRetry!: () => void;
    const first = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const retry = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });

    tracker(first);
    tracker(retry);
    rejectFirst(new Error('retryable shared load failed'));
    await expect(first).rejects.toThrow('retryable shared load failed');
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(cache.pendingShareLoads).toEqual([retry]);
    resolveRetry();
    await expect(retry).resolves.toBeUndefined();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(cache.pendingShareLoads).toEqual([]);
  });

  it('aliases default-scoped and legacy share cache keys both ways', async () => {
    const { getRuntimeModuleCacheBootstrapCode } = await import('../virtualRuntimeInitStatus');
    const legacyReact = { source: 'legacy-react' };
    const legacyVersioned = { source: 'legacy-versioned' };
    const defaultVue = { source: 'default-vue' };
    const defaultVersioned = { source: 'default-versioned' };
    const customScoped = { source: 'custom-scope' };
    const existingDefaultReact = { source: 'existing-default-react' };
    (globalThis as any).__mf_module_cache__ = {
      share: {
        react: legacyReact,
        'default:react': existingDefaultReact,
        'react@1.2.3': legacyVersioned,
        'default:vue': defaultVue,
        'default:vue@2.0.0': defaultVersioned,
        'react-18:react': customScoped,
      },
      remote: {},
    };

    const share = runCode<Record<string, unknown>>(
      getRuntimeModuleCacheBootstrapCode(),
      'return __mfModuleCache.share;'
    );

    expect(share['default:react']).toBe(existingDefaultReact);
    expect(share.react).toBe(legacyReact);
    expect(share['default:react@1.2.3']).toBe(legacyVersioned);
    expect(share.vue).toBe(defaultVue);
    expect(share['vue@2.0.0']).toBe(defaultVersioned);
    expect(share['react-18:react']).toBe(customScoped);
    expect(share['default:react-18:react']).toBeUndefined();
  });

  it('promise bootstrap with enableSsrInit resolves to SSR no-op runtime', async () => {
    const { getRuntimeInitPromiseBootstrapCode } = await import('../virtualRuntimeInitStatus');

    const result = runCode<{ initPromise: Promise<{ loadRemote: Function; loadShare: Function }> }>(
      getRuntimeInitPromiseBootstrapCode(true).replaceAll('import.meta.env.SSR', 'true'),
      'return { initPromise, hasInitResolve: typeof initResolve !== "undefined" };'
    );

    await expect(
      result.initPromise.then((runtime) => runtime.loadRemote())
    ).resolves.toBeUndefined();
    await expect(
      result.initPromise.then((runtime) => runtime.loadShare())
    ).resolves.toBeUndefined();
    expect((result as any).hasInitResolve).toBe(false);
  });

  it('promise bootstrap without enableSsrInit leaves initPromise pending', async () => {
    const { getRuntimeInitPromiseBootstrapCode } = await import('../virtualRuntimeInitStatus');

    const result = runCode<{ initPromise: Promise<unknown> }>(
      getRuntimeInitPromiseBootstrapCode(),
      'return { initPromise };'
    );

    // No SSR init code emitted — initPromise should remain pending (never resolve).
    let resolved = false;
    result.initPromise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
  });

  it('resolve bootstrap reuses promise state and exposes only initResolve', async () => {
    const { getRuntimeInitPromiseBootstrapCode, getRuntimeInitResolveBootstrapCode } =
      await import('../virtualRuntimeInitStatus');

    runCode(getRuntimeInitPromiseBootstrapCode(), 'return initPromise;');
    const initResolve = runCode<Function>(
      getRuntimeInitResolveBootstrapCode(),
      'return initResolve;'
    );

    expect(initResolve).toBe((globalThis as any)['__mf_init__virtual:runtimeInit__'].initResolve);
  });

  it('keeps promise and resolve bootstrap strings intentionally distinct', async () => {
    const { getRuntimeInitPromiseBootstrapCode, getRuntimeInitResolveBootstrapCode } =
      await import('../virtualRuntimeInitStatus');

    const promiseCode = getRuntimeInitPromiseBootstrapCode();
    const resolveCode = getRuntimeInitResolveBootstrapCode();

    expect(promiseCode).toContain('__mfPromiseGlobalKey');
    expect(promiseCode).toContain('const initPromise = __mfPromiseState.initPromise;');
    expect(resolveCode).toContain('__mfResolveGlobalKey');
    expect(resolveCode).toContain('const initResolve = __mfResolveState.initResolve;');
    expect(resolveCode).not.toBe(promiseCode);
  });

  it('writes ESM exports for build and CommonJS exports for serve', async () => {
    const { writeRuntimeInitStatus } = await import('../virtualRuntimeInitStatus');

    writeRuntimeInitStatus('build');
    expect(writeSyncSpy.mock.calls.at(-1)?.[0]).toContain(
      'export { initPromise, initResolve, initReject, moduleCache };'
    );

    writeRuntimeInitStatus('serve');
    expect(writeSyncSpy.mock.calls.at(-1)?.[0]).toContain(
      'module.exports = globalThis[globalKey];'
    );
  });

  it('serializes SSR remotes into build init code', async () => {
    const { setSsrRemotes, writeRuntimeInitStatus } = await import('../virtualRuntimeInitStatus');

    setSsrRemotes([
      { name: 'remote', entry: 'http://localhost:4174/remoteEntry.js', type: 'module' },
    ]);
    writeRuntimeInitStatus('build', true);

    const code = writeSyncSpy.mock.calls.at(-1)?.[0] ?? '';
    expect(code).toContain('"name":"remote"');
    expect(code).toContain('"entry":"http://localhost:4174/remoteEntry.js"');
  });

  it('maps configured remotes through the scoped runtime alias', async () => {
    const { getRuntimeRemoteAlias, getSsrRuntimeRemotes } =
      await import('../virtualRuntimeInitStatus');
    const { normalizeModuleFederationOptions } =
      await import('../../utils/normalizeModuleFederationOptions');

    const options = normalizeModuleFederationOptions({
      name: 'ssr-host',
      remotes: {
        remote: {
          type: 'module',
          name: 'remote',
          entry: 'http://localhost:4174/remoteEntry.js',
        },
      },
    });

    expect(getSsrRuntimeRemotes(options.remotes, options)).toEqual([
      {
        name: getRuntimeRemoteAlias('remote', options),
        entry: 'http://localhost:4174/remoteEntry.js',
        type: 'module',
      },
    ]);
  });
});
