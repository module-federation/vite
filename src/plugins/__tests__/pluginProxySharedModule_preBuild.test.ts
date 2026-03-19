import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hasPackageDependencyMock } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn(),
}));

vi.mock('../../utils/packageUtils', () => ({
  hasPackageDependency: hasPackageDependencyMock,
  setPackageDetectionCwd: vi.fn(),
  getIsRolldown: () => false,
}));

import { proxySharedModule } from '../pluginProxySharedModule_preBuild';
import { NormalizedShared } from '../../utils/normalizeModuleFederationOptions';

function makeShared(): NormalizedShared {
  return {
    react: {
      name: 'react',
      from: '',
      version: '19.2.4',
      scope: 'default',
      shareConfig: {
        singleton: true,
        requiredVersion: '^19.2.4',
        strictVersion: false,
      },
    },
    vue: {
      name: 'vue',
      from: '',
      version: '3.4.0',
      scope: 'default',
      shareConfig: {
        singleton: false,
        requiredVersion: '^3.4.0',
        strictVersion: false,
      },
    },
  };
}

describe('pluginProxySharedModule_preBuild', () => {
  beforeEach(() => {
    hasPackageDependencyMock.mockReset();
  });

  for (const testCase of [
    {
      name: 'does not proxy react through loadShare in serve mode when vinext is enabled',
      source: 'react',
      hasVinext: true,
      aliasExpected: false,
      shouldProxy: false,
    },
    {
      name: 'proxies react through loadShare in serve mode when vinext is disabled',
      source: 'react',
      hasVinext: false,
      aliasExpected: true,
      shouldProxy: true,
    },
    {
      name: 'proxies non-react shared modules through loadShare in serve mode when vinext is enabled',
      source: 'vue',
      hasVinext: true,
      aliasExpected: true,
      shouldProxy: true,
    },
    {
      name: 'proxies non-react shared modules through loadShare in serve mode when vinext is disabled',
      source: 'vue',
      hasVinext: false,
      aliasExpected: true,
      shouldProxy: true,
    },
  ]) {
    it(testCase.name, async () => {
      hasPackageDependencyMock.mockImplementation((pkg: string) => {
        return pkg === 'vinext' ? testCase.hasVinext : false;
      });

      const plugins = proxySharedModule({ shared: makeShared() });
      const proxyPlugin = plugins[1];
      const config = {
        resolve: {
          alias: [] as Array<{
            find: RegExp;
            customResolver?: (source: string, importer: string) => unknown;
          }>,
        },
      };

      proxyPlugin.config?.call(
        {
          meta: {},
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        },
        config as any,
        {
          command: 'serve',
          mode: 'development',
        }
      );

      const alias = config.resolve.alias.find((entry) => entry.find.test(testCase.source));
      if (!testCase.aliasExpected) {
        expect(alias).toBeUndefined();
        return;
      }

      expect(alias).toBeDefined();

      if (testCase.shouldProxy) {
        expect(alias?.customResolver).toBeTypeOf('function');
        return;
      }

      const resolution = await alias?.customResolver?.call(
        {
          resolve: async (id: string) => ({ id: `/resolved/${id}` }),
        },
        testCase.source,
        '/src/main.ts'
      );
      expect(resolution).toBeUndefined();
    });
  }
});
