import type { ConfigEnv, ConfigPluginContext, Rollup, UserConfig } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

const {
  addUsedRemoteMock,
  getInstalledPackageEntryMock,
  getRemoteVirtualModuleMock,
  remoteModulePath,
} = vi.hoisted(() => ({
  addUsedRemoteMock: vi.fn(),
  getInstalledPackageEntryMock: vi.fn<(pkg: string) => string | undefined>(() => undefined),
  getRemoteVirtualModuleMock: vi.fn(),
  remoteModulePath: '/virtual/scheduler.js',
}));

vi.mock('../../utils/packageUtils', () => ({
  getInstalledPackageEntry: getInstalledPackageEntryMock,
  getPackageDetectionCwd: vi.fn(() => '/repo'),
}));

vi.mock('../../virtualModules', () => ({
  addUsedRemote: addUsedRemoteMock,
  getRemoteVirtualModule: getRemoteVirtualModuleMock,
  refreshHostAutoInit: vi.fn(),
}));

import pluginProxyRemotes from '../pluginProxyRemotes';

type AliasEntry = {
  find: RegExp;
  replacement?: string;
  customResolver?: (source: string, importer?: string) => unknown;
};

type MockUserConfig = UserConfig & {
  resolve: {
    alias: AliasEntry[];
  };
};

type TestPluginMeta = {
  rollupVersion: string;
  rolldownVersion: string;
  viteVersion: string;
  watchMode: boolean;
};

function createPluginMeta(overrides: Partial<TestPluginMeta> = {}): TestPluginMeta {
  return {
    rollupVersion: '4.0.0',
    rolldownVersion: '1.0.0',
    viteVersion: '7.0.0',
    watchMode: false,
    ...overrides,
  };
}

function runConfig(plugin: ReturnType<typeof pluginProxyRemotes>, config: MockUserConfig): void {
  callHook(plugin.config, { meta: createPluginMeta() } as unknown as ConfigPluginContext, config, {
    command: 'serve',
    mode: 'test',
  } as ConfigEnv);
}

function runResolveId(
  plugin: ReturnType<typeof pluginProxyRemotes>,
  source: string,
  importer: string | undefined
) {
  return callHook(
    plugin.resolveId,
    { meta: createPluginMeta() } as unknown as Rollup.PluginContext,
    source,
    importer,
    { isEntry: false }
  );
}

describe('pluginProxyRemotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRemoteVirtualModuleMock.mockReturnValue({
      getPath: () => remoteModulePath,
    });
  });

  function getSchedulerAlias() {
    return getSchedulerPluginAndConfig().config.resolve.alias[0];
  }

  function getSchedulerPluginAndConfig(configOverrides = {}) {
    const plugin = pluginProxyRemotes(
      normalizeModuleFederationOptions({
        name: 'host',
        remotes: {
          scheduler: 'scheduler@http://example.com/remoteEntry.js',
        },
      })
    );
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
      ...configOverrides,
    };

    runConfig(plugin, config);
    return { plugin, config };
  }

  it('still matches bare remote ids', () => {
    const alias = getSchedulerAlias();

    expect(alias.find.test('scheduler')).toBe(true);
    expect(alias.find.test('scheduler/SchedulePanel')).toBe(true);
    expect(alias.customResolver).toBeUndefined();
  });

  it('still proxies bare remote ids from app importers via resolveId', () => {
    const plugin = pluginProxyRemotes(
      normalizeModuleFederationOptions({
        name: 'host',
        remotes: {
          scheduler: 'scheduler@http://example.com/remoteEntry.js',
        },
      })
    );
    const config: MockUserConfig = {
      resolve: {
        alias: [],
      },
    };

    runConfig(plugin, config);
    const result = runResolveId(plugin, 'scheduler', '/repo/src/App.tsx');

    expect(result).toBe(remoteModulePath);
    expect(getRemoteVirtualModuleMock).toHaveBeenCalledWith('scheduler', 'serve');
    expect(addUsedRemoteMock).toHaveBeenCalledWith('scheduler', 'scheduler');
  });

  it('still proxies bare remote ids from node_modules importers when no package collides', () => {
    const { plugin } = getSchedulerPluginAndConfig();

    const result = runResolveId(plugin, 'scheduler', '/repo/node_modules/.vite/deps/react-dom.js');

    expect(result).toBe(remoteModulePath);
    expect(getRemoteVirtualModuleMock).toHaveBeenCalledWith('scheduler', 'serve');
    expect(addUsedRemoteMock).toHaveBeenCalledWith('scheduler', 'scheduler');
  });

  it('resolves colliding installed packages for bare ids in node_modules importers', () => {
    getInstalledPackageEntryMock.mockReturnValue('/repo/node_modules/.pnpm/scheduler/index.js');
    const { plugin } = getSchedulerPluginAndConfig({ root: '/repo' });
    const result = runResolveId(plugin, 'scheduler', '/repo/node_modules/.vite/deps/react-dom.js');

    expect(result as string | undefined).toBe('/repo/node_modules/.pnpm/scheduler/index.js');
    expect(getRemoteVirtualModuleMock).not.toHaveBeenCalled();
    expect(addUsedRemoteMock).not.toHaveBeenCalled();
  });

  it('still proxies remote subpaths from node_modules importers', () => {
    const { plugin } = getSchedulerPluginAndConfig();

    const result = runResolveId(
      plugin,
      'scheduler/SchedulePanel',
      '/repo/node_modules/some-package/index.js'
    );

    expect(result).toBe(remoteModulePath);
    expect(getRemoteVirtualModuleMock).toHaveBeenCalledWith('scheduler/SchedulePanel', 'serve');
    expect(addUsedRemoteMock).toHaveBeenCalledWith('scheduler', 'scheduler/SchedulePanel');
  });
});
