import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addUsedRemoteMock,
  getInstalledPackageEntryMock,
  getIsRolldownMock,
  getRemoteVirtualModuleMock,
  remoteModulePath,
} = vi.hoisted(() => ({
  addUsedRemoteMock: vi.fn(),
  getInstalledPackageEntryMock: vi.fn(() => undefined),
  getIsRolldownMock: vi.fn(() => true),
  getRemoteVirtualModuleMock: vi.fn(),
  remoteModulePath: '/virtual/scheduler.js',
}));

vi.mock('../../utils/packageUtils', () => ({
  getInstalledPackageEntry: getInstalledPackageEntryMock,
  getIsRolldown: getIsRolldownMock,
}));

vi.mock('../../virtualModules', () => ({
  addUsedRemote: addUsedRemoteMock,
  getRemoteVirtualModule: getRemoteVirtualModuleMock,
}));

import pluginProxyRemotes from '../pluginProxyRemotes';

describe('pluginProxyRemotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRemoteVirtualModuleMock.mockReturnValue({
      getPath: () => remoteModulePath,
    });
  });

  function getSchedulerAlias() {
    const plugin = pluginProxyRemotes({
      remotes: {
        scheduler: {
          name: 'scheduler',
        },
      },
    } as any);
    const config = {
      resolve: {
        alias: [],
      },
    } as any;

    (plugin as any).config.call({} as any, config, { command: 'serve' });
    return config.resolve.alias[0];
  }

  it('still matches bare remote ids', () => {
    const alias = getSchedulerAlias();

    expect(alias.find.test('scheduler')).toBe(true);
    expect(alias.find.test('scheduler/SchedulePanel')).toBe(true);
  });

  it('still proxies bare remote ids from app importers via resolveId', () => {
    const plugin = pluginProxyRemotes({
      remotes: {
        scheduler: {
          name: 'scheduler',
        },
      },
    } as any);
    const config = {
      resolve: {
        alias: [],
      },
    } as any;

    (plugin as any).config.call({ meta: { rolldownVersion: '1.0.0' } } as any, config, {
      command: 'serve',
    });
    const result = (plugin as any).resolveId.call(
      { meta: { rolldownVersion: '1.0.0' } } as any,
      'scheduler',
      '/repo/src/App.tsx'
    );

    expect(result).toBe(remoteModulePath);
    expect(getRemoteVirtualModuleMock).toHaveBeenCalledWith('scheduler', 'serve', true);
    expect(addUsedRemoteMock).toHaveBeenCalledWith('scheduler', 'scheduler');
  });

  it('still proxies bare remote ids from node_modules importers when no package collides', () => {
    const alias = getSchedulerAlias();

    const result = alias.customResolver('scheduler', '/repo/node_modules/.vite/deps/react-dom.js');

    expect(result).toBe(remoteModulePath);
    expect(getRemoteVirtualModuleMock).toHaveBeenCalledWith('scheduler', 'serve', true);
    expect(addUsedRemoteMock).toHaveBeenCalledWith('scheduler', 'scheduler');
  });

  it('resolves colliding installed packages for bare ids in node_modules importers', () => {
    getInstalledPackageEntryMock.mockReturnValue('/repo/node_modules/.pnpm/scheduler/index.js');
    const plugin = pluginProxyRemotes({
      remotes: {
        scheduler: {
          name: 'scheduler',
        },
      },
    } as any);
    const config = {
      root: '/repo',
      resolve: {
        alias: [],
      },
    } as any;

    (plugin as any).config.call({ meta: { rolldownVersion: '1.0.0' } } as any, config, {
      command: 'serve',
    });
    const alias = config.resolve.alias[0];
    const result = alias.customResolver('scheduler', '/repo/node_modules/.vite/deps/react-dom.js');

    expect(result).toBe('/repo/node_modules/.pnpm/scheduler/index.js');
    expect(getRemoteVirtualModuleMock).not.toHaveBeenCalled();
    expect(addUsedRemoteMock).not.toHaveBeenCalled();
  });

  it('still proxies remote subpaths from node_modules importers', () => {
    const alias = getSchedulerAlias();

    const result = alias.customResolver(
      'scheduler/SchedulePanel',
      '/repo/node_modules/some-package/index.js'
    );

    expect(result).toBe(remoteModulePath);
    expect(getRemoteVirtualModuleMock).toHaveBeenCalledWith(
      'scheduler/SchedulePanel',
      'serve',
      true
    );
    expect(addUsedRemoteMock).toHaveBeenCalledWith('scheduler', 'scheduler/SchedulePanel');
  });
});
