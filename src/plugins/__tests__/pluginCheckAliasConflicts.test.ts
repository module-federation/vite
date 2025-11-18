import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAliasConflicts } from '../pluginCheckAliasConflicts';

describe('pluginCheckAliasConflicts', () => {
  let consoleWarnSpy: any;
  let mockLogger: any;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('should warn when alias conflicts with shared module', () => {
    const plugin = checkAliasConflicts({
      shared: {
        vue: {
          name: 'vue',
          version: '3.2.45',
          scope: 'default',
          from: 'host',
          shareConfig: {
            requiredVersion: '^3.2.45',
          } as any,
        },
        pinia: {
          name: 'pinia',
          version: '2.0.28',
          scope: 'default',
          from: 'host',
          shareConfig: {
            requiredVersion: '^2.0.28',
          } as any,
        },
      },
    });

    const mockConfig = {
      logger: mockLogger,
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

    plugin.configResolved!(mockConfig as any);

    expect(mockLogger.warn).toHaveBeenCalledTimes(5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '\n[Module Federation] Detected alias conflicts with shared modules:'
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Shared module "vue" is aliased by "vue"')
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Shared module "pinia" is aliased by "pinia"')
    );
  });

  it('should not warn when no alias conflicts exist', () => {
    const plugin = checkAliasConflicts({
      shared: {
        vue: {
          name: 'vue',
          version: '3.2.45',
          scope: 'default',
          from: 'host',
          shareConfig: {
            requiredVersion: '^3.2.45',
          } as any,
        },
      },
    });

    const mockConfig = {
      logger: mockLogger,
      resolve: {
        alias: [
          {
            find: 'shared',
            replacement: '/path/to/project/shared/shared',
          },
        ],
      },
    };

    plugin.configResolved!(mockConfig as any);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('should not warn when shared is empty', () => {
    const plugin = checkAliasConflicts({
      shared: {},
    });

    const mockConfig = {
      logger: mockLogger,
      resolve: {
        alias: [
          {
            find: 'vue',
            replacement: '/path/to/project/node_modules/vue/dist/vue.runtime.esm-bundler.js',
          },
        ],
      },
    };

    plugin.configResolved!(mockConfig as any);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('should handle regex alias patterns', () => {
    const plugin = checkAliasConflicts({
      shared: {
        react: {
          name: 'react',
          version: '18.0.0',
          scope: 'default',
          from: 'host',
          shareConfig: {
            requiredVersion: '^18.0.0',
          } as any,
        },
      },
    });

    const mockConfig = {
      logger: mockLogger,
      resolve: {
        alias: [
          {
            find: /^react$/,
            replacement: '/path/to/project/node_modules/react/index.js',
          },
        ],
      },
    };

    plugin.configResolved!(mockConfig as any);

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Shared module "react" is aliased')
    );
  });

  it('should handle shared modules with trailing slash', () => {
    const plugin = checkAliasConflicts({
      shared: {
        'lodash/': {
          name: 'lodash/',
          version: '4.17.21',
          scope: 'default',
          from: 'host',
          shareConfig: {
            requiredVersion: '^4.17.21',
          } as any,
        },
      },
    });

    const mockConfig = {
      logger: mockLogger,
      resolve: {
        alias: [
          {
            find: 'lodash',
            replacement: '/path/to/project/node_modules/lodash',
          },
        ],
      },
    };

    plugin.configResolved!(mockConfig as any);

    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
