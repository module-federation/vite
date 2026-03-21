import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeSyncSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
}));

vi.mock('../../utils/VirtualModule', () => {
  return {
    default: class MockVirtualModule {
      name: string;
      suffix: string;

      constructor(name: string, _tag: string, suffix: string) {
        this.name = name;
        this.suffix = suffix;
      }

      writeSync = writeSyncSpy;
    },
  };
});

vi.mock('../virtualRuntimeInitStatus', () => {
  return {
    getRuntimeInitBootstrapCode: () => 'const globalKey = "__mf__";',
    getRuntimeInitPromiseBootstrapCode: () => 'const initPromise = Promise.resolve();',
    virtualRuntimeInitStatus: {
      getImportId: () => 'virtual:init-status',
    },
  };
});

describe('virtualRemotes', () => {
  beforeEach(() => {
    writeSyncSpy.mockClear();
    vi.resetModules();
  });

  it('writes dev remotes without cache eviction on first render', async () => {
    const mod = await import('../virtualRemotes');
    const remote = mod.getRemoteVirtualModule('remote/Button', 'serve', false);

    expect(remote).toBeDefined();
    const code = writeSyncSpy.mock.calls[0][0] as string;
    expect(code).toContain('const __mfHmrVersion = 0;');
    expect(code).toContain('runtime.loadRemote("remote/Button")');
  });

  it('rewrites dev remotes with bumped HMR version on invalidation', async () => {
    const mod = await import('../virtualRemotes');
    mod.getRemoteVirtualModule('remote/Button', 'serve', false);
    writeSyncSpy.mockClear();

    mod.invalidateRemoteVirtualModule('remote/Button');

    const code = writeSyncSpy.mock.calls[0][0] as string;
    expect(code).toContain('const __mfHmrVersion = 1;');
    expect(code).toContain('runtime.remoteHandler.removeRemote(remote)');
    expect(code).toContain('runtime.registerRemotes([nextRemote])');
  });
});
