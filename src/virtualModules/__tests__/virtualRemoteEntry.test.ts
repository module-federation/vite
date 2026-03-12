import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';

const { writeSyncSpy } = vi.hoisted(() => ({
  writeSyncSpy: vi.fn(),
}));

vi.mock('../../utils/VirtualModule', () => {
  return {
    default: class MockVirtualModule {
      getPath = vi.fn(() => '/mock/hostAutoInit.js');
      getImportId = vi.fn(() => 'mock-host-auto-init');
      writeSync = writeSyncSpy;
    },
  };
});

describe('virtualRemoteEntry', () => {
  beforeEach(() => {
    writeSyncSpy.mockClear();
    normalizeModuleFederationOptions({
      name: 'host-app',
      filename: 'remoteEntry.js',
      exposes: {},
      remotes: {},
      shared: {},
    });
  });

  it('resolves init before waiting on initializeSharing', async () => {
    const { generateRemoteEntry } = await import('../virtualRemoteEntry');

    const code = generateRemoteEntry(
      normalizeModuleFederationOptions({
        name: 'host-app',
        filename: 'remoteEntry.js',
        exposes: {},
        remotes: {},
        shared: {},
        shareStrategy: 'version-first',
      })
    );

    expect(code.indexOf('initResolve(initRes)')).toBeGreaterThan(-1);
    expect(code.indexOf('await Promise.all(await initRes.initializeSharing')).toBeGreaterThan(-1);
    expect(code.indexOf('initResolve(initRes)')).toBeLessThan(
      code.indexOf('await Promise.all(await initRes.initializeSharing')
    );
  });

  it('writes host auto init that awaits init before __tla', async () => {
    const { writeHostAutoInit } = await import('../virtualRemoteEntry');

    writeHostAutoInit('virtual:remote-entry');

    expect(writeSyncSpy).toHaveBeenCalledTimes(1);
    const code = writeSyncSpy.mock.calls[0][0];
    expect(code).toContain('Promise.resolve(remoteEntry.init?.())');
    expect(code).toContain('.then(() => remoteEntry.__tla)');
    expect(code).not.toContain('.then(remoteEntry.init).catch(remoteEntry.init)');
  });
});
