import type { Alias, MinimalPluginContextWithoutEnvironment } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAliasConflicts } from '../pluginCheckAliasConflicts';
import type { ShareItem } from '../../utils/normalizeModuleFederationOptions';
import { callHook } from '../../utils/__tests__/viteHookHelpers';

function createSharedItem(name: string, version: string): ShareItem {
  return {
    name,
    version,
    scope: 'default',
    from: 'host',
    shareConfig: {
      requiredVersion: `^${version}`,
    },
  };
}

type MockResolvedConfig = {
  resolve?: {
    alias?: Alias[];
  };
};

function runConfigResolved(
  plugin: ReturnType<typeof checkAliasConflicts>,
  config: MockResolvedConfig
): void {
  callHook(
    plugin.configResolved,
    {} as MinimalPluginContextWithoutEnvironment,
    config as unknown as import('vite').ResolvedConfig
  );
}

describe('pluginCheckAliasConflicts', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('should warn when alias conflicts with shared module', () => {
    const plugin = checkAliasConflicts({
      shared: {
        vue: createSharedItem('vue', '3.2.45'),
        pinia: createSharedItem('pinia', '2.0.28'),
      },
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: [
          {
            find: 'vue',
            replacement: '/path/to/project/node_modules/vue/dist/vue.runtime.esm-bundler.js',
          },
          {
            find: 'pinia',
            replacement: '/path/to/project/node_modules/pinia/dist/pinia.mjs',
          },
          {
            find: 'shared',
            replacement: '/path/to/project/shared/shared',
          },
        ],
      },
    };

    runConfigResolved(plugin, mockConfig);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(4);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[Module Federation] Detected alias conflicts with shared modules:'
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Shared module "vue" is aliased by "vue"')
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Shared module "pinia" is aliased by "pinia"')
    );
  });

  it('should not warn when no alias conflicts exist', () => {
    const plugin = checkAliasConflicts({
      shared: {
        vue: createSharedItem('vue', '3.2.45'),
      },
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: [
          {
            find: 'shared',
            replacement: '/path/to/project/shared/shared',
          },
        ],
      },
    };

    runConfigResolved(plugin, mockConfig);

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should not warn when shared is empty', () => {
    const plugin = checkAliasConflicts({
      shared: {},
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: [
          {
            find: 'vue',
            replacement: '/path/to/project/node_modules/vue/dist/vue.runtime.esm-bundler.js',
          },
        ],
      },
    };

    runConfigResolved(plugin, mockConfig);

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should handle regex alias patterns', () => {
    const plugin = checkAliasConflicts({
      shared: {
        react: createSharedItem('react', '18.0.0'),
      },
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: [
          {
            find: /^react$/,
            replacement: '/path/to/project/node_modules/react/index.js',
          },
        ],
      },
    };

    runConfigResolved(plugin, mockConfig);

    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Shared module "react" is aliased')
    );
  });

  it('should handle shared modules with trailing slash', () => {
    const plugin = checkAliasConflicts({
      shared: {
        'lodash/': createSharedItem('lodash/', '4.17.21'),
      },
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: [
          {
            find: 'lodash',
            replacement: '/path/to/project/node_modules/lodash',
          },
        ],
      },
    };

    runConfigResolved(plugin, mockConfig);

    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it('should work with undefined alias', () => {
    const plugin = checkAliasConflicts({
      shared: {
        vue: createSharedItem('vue', '3.2.45'),
      },
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: undefined,
      },
    };

    runConfigResolved(plugin, mockConfig);

    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should skip Module Federation internal aliases (replacement $1)', () => {
    const plugin = checkAliasConflicts({
      shared: {
        vue: createSharedItem('vue', '3.2.45'),
        'react-dom': createSharedItem('react-dom', '18.0.0'),
      },
    });

    const mockConfig: MockResolvedConfig = {
      resolve: {
        alias: [
          {
            find: /^vue$/,
            replacement: '$1',
          },
          {
            find: /^react-dom$/,
            replacement: '$1',
          },
        ],
      },
    };

    runConfigResolved(plugin, mockConfig);

    // Should not warn for internal MF aliases with replacement '$1'
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
