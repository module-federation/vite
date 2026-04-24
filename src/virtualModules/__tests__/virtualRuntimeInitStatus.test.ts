import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeSyncSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
}));

vi.mock('../../utils/VirtualModule', () => ({
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

  it('promise bootstrap exposes only initPromise and resolves to SSR no-op runtime', async () => {
    const { getRuntimeInitPromiseBootstrapCode } = await import('../virtualRuntimeInitStatus');

    const result = runCode<{ initPromise: Promise<{ loadRemote: Function; loadShare: Function }> }>(
      getRuntimeInitPromiseBootstrapCode(),
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
});
