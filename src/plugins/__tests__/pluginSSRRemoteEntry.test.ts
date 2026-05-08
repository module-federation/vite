import type { Rollup, ResolvedConfig } from 'vite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';

const { getIsRolldownMock } = vi.hoisted(() => ({
  getIsRolldownMock: vi.fn<(ctx: unknown) => boolean>(() => false),
}));

vi.mock('../../utils/packageUtils', () => ({
  getIsRolldown: getIsRolldownMock,
  hasPackageDependency: vi.fn(() => false),
  getPackageDetectionCwd: vi.fn(() => '/mock/cwd'),
  setPackageDetectionCwd: vi.fn(),
  getPackageName: vi.fn((s: string) => s.split('/')[0]),
  getPackageNameFromNodeModulePath: vi.fn(),
  packageNameEncode: vi.fn((s: string) => s),
  packageNameDecode: vi.fn((s: string) => s),
  getInstalledPackageJson: vi.fn(),
  getInstalledPackageEntry: vi.fn(),
  getExtFromNpmPackage: vi.fn(() => '.js'),
}));

vi.mock('../../virtualModules/virtualExposesSSR', () => ({
  generateExposesSSR: vi.fn(() => 'export default {}'),
  getVirtualExposesSSRId: vi.fn(
    (opts: { internalName: string }) => `virtual:mf-exposes-ssr:${opts.internalName}`
  ),
}));

vi.mock('../../virtualModules/virtualRemoteEntrySSR', () => ({
  generateRemoteEntrySSR: vi.fn(() => 'export { init, get }'),
  getRemoteEntrySSRId: vi.fn(
    (opts: { internalName: string; filename: string }) =>
      `virtual:mf-REMOTE_ENTRY_SSR_ID:${opts.internalName}__${opts.filename.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  ),
  getSSRFilename: vi.fn((filename: string, isCJS: boolean) => {
    const base = filename.replace(/\.[^.]+$/, '');
    return `${base}.server.${isCJS ? 'cjs' : 'js'}`;
  }),
}));

import { pluginSSRRemoteEntry } from '../pluginSSRRemoteEntry';

function makeOptions(overrides: Record<string, unknown> = {}) {
  return normalizeModuleFederationOptions({
    name: 'remote',
    filename: 'remoteEntry.js',
    exposes: { './Widget': './src/Widget.tsx' },
    shared: { react: { singleton: true } },
    ...overrides,
  });
}

function makePluginMeta(rolldown = false): Rollup.PluginContext['meta'] {
  return {
    rollupVersion: '4.0.0',
    ...(rolldown ? { viteVersion: '8.0.0', rolldownVersion: '1.0.0' } : {}),
    watchMode: false,
  } as Rollup.PluginContext['meta'];
}

function makeEmitFile() {
  return vi.fn<Rollup.PluginContext['emitFile']>();
}

describe('pluginSSRRemoteEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIsRolldownMock.mockReturnValue(false);
  });

  it('returns two plugins with correct names and enforce', () => {
    const plugins = pluginSSRRemoteEntry(makeOptions());
    expect(plugins).toHaveLength(2);
    expect(plugins[0].name).toBe('mf:ssr-remote-entry:pre');
    expect(plugins[0].enforce).toBe('pre');
    // apply is intentionally absent — resolveId/load must run in both serve and build
    // so the Vite dev server can respond to virtual SSR module requests.
    expect(plugins[0].apply).toBeUndefined();
    expect(plugins[1].name).toBe('mf:ssr-remote-entry');
    expect(plugins[1].apply).toBeUndefined();
  });

  describe('pre-plugin — configResolved', () => {
    it('maps alias replacement path to bare package name', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];

      const config = {
        resolve: {
          alias: [{ find: '@module-federation/runtime', replacement: '/abs/path/to/runtime.js' }],
        },
      } as unknown as ResolvedConfig;

      callHook(prePlugin.configResolved, {} as Rollup.PluginContext, config);

      // After configResolved, resolveId should re-externalise the abs path
      const result = callHook(
        prePlugin.resolveId,
        { resolve: vi.fn() } as unknown as Rollup.PluginContext,
        '/abs/path/to/runtime.js',
        `virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js`,
        { isEntry: false }
      );

      expect(result).toEqual({ id: '@module-federation/runtime', external: true });
    });

    it('handles regex aliases', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];

      const config = {
        resolve: {
          alias: [
            { find: /^@module-federation\/runtime$/, replacement: '/abs/path/to/runtime.js' },
          ],
        },
      } as unknown as ResolvedConfig;

      callHook(prePlugin.configResolved, {} as Rollup.PluginContext, config);

      const result = callHook(
        prePlugin.resolveId,
        { resolve: vi.fn() } as unknown as Rollup.PluginContext,
        '/abs/path/to/runtime.js',
        `virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js`,
        { isEntry: false }
      );

      expect(result).toEqual({ id: '@module-federation/runtime', external: true });
    });
  });

  describe('pre-plugin — resolveId', () => {
    it('returns virtual SSR remote entry ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(prePlugin.resolveId, {} as Rollup.PluginContext, ssrId, undefined, {
        isEntry: false,
      });

      expect(result).toBe(ssrId);
    });

    it('returns virtual exposes SSR ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const exposesId = 'virtual:mf-exposes-ssr:__mfe_internal__remote';

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        exposesId,
        undefined,
        { isEntry: false }
      );

      expect(result).toBe(exposesId);
    });

    it('returns undefined when importer is not in SSR graph', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        '@module-federation/runtime',
        '/some/browser/file.js',
        { isEntry: false }
      );

      expect(result).toBeUndefined();
    });

    it('externalises SSR-only bare specifiers when importer is in SSR graph', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        '@module-federation/runtime',
        ssrId,
        { isEntry: false }
      );

      expect(result).toEqual({ id: '@module-federation/runtime', external: true });
    });

    it('externalises @module-federation/runtime-core and sdk', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      expect(
        callHook(
          prePlugin.resolveId,
          {} as Rollup.PluginContext,
          '@module-federation/runtime-core',
          ssrId,
          { isEntry: false }
        )
      ).toEqual({ id: '@module-federation/runtime-core', external: true });

      expect(
        callHook(prePlugin.resolveId, {} as Rollup.PluginContext, '@module-federation/sdk', ssrId, {
          isEntry: false,
        })
      ).toEqual({ id: '@module-federation/sdk', external: true });
    });

    it('externalises user-provided ssrExternals', () => {
      const base = makeOptions();
      const options = { ...base, ssrExternals: ['my-server-only-pkg'] };
      const plugins = pluginSSRRemoteEntry(options);
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(
        prePlugin.resolveId,
        {} as Rollup.PluginContext,
        'my-server-only-pkg',
        ssrId,
        { isEntry: false }
      );

      expect(result).toEqual({ id: 'my-server-only-pkg', external: true });
    });

    it('does not track bare specifiers into the SSR graph', () => {
      const resolveMock = vi.fn();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      callHook(
        prePlugin.resolveId,
        { resolve: resolveMock } as unknown as Rollup.PluginContext,
        'react',
        ssrId,
        { isEntry: false }
      );

      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('tracks relative imports into the SSR graph', async () => {
      const resolved = { id: '/abs/path/to/dep.js' };
      const resolveMock = vi.fn().mockResolvedValue(resolved);
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const prePlugin = plugins[0];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      await callHook(
        prePlugin.resolveId,
        { resolve: resolveMock } as unknown as Rollup.PluginContext,
        './assets/helper.js',
        ssrId,
        { isEntry: false }
      );

      expect(resolveMock).toHaveBeenCalledWith('./assets/helper.js', ssrId, { skipSelf: true });
    });
  });

  describe('main plugin — resolveId', () => {
    it('returns virtual SSR remote entry ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      expect(
        callHook(mainPlugin.resolveId, {} as Rollup.PluginContext, ssrId, undefined, {
          isEntry: false,
        })
      ).toBe(ssrId);
    });

    it('returns virtual exposes SSR ID as-is', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const exposesId = 'virtual:mf-exposes-ssr:__mfe_internal__remote';

      expect(
        callHook(mainPlugin.resolveId, {} as Rollup.PluginContext, exposesId, undefined, {
          isEntry: false,
        })
      ).toBe(exposesId);
    });
  });

  describe('main plugin — load', () => {
    it('returns SSR remote entry code for SSR entry ID', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const ssrId = 'virtual:mf-REMOTE_ENTRY_SSR_ID:__mfe_internal__remote__remoteEntry_js';

      const result = callHook(mainPlugin.load, {} as Rollup.PluginContext, ssrId);

      expect(result).toBe('export { init, get }');
    });

    it('returns SSR exposes map for exposes ID', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];
      const exposesId = 'virtual:mf-exposes-ssr:__mfe_internal__remote';

      const result = callHook(mainPlugin.load, {} as Rollup.PluginContext, exposesId);

      expect(result).toBe('export default {}');
    });

    it('returns undefined for unknown IDs', () => {
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      expect(
        callHook(mainPlugin.load, {} as Rollup.PluginContext, '/some/other/file.js')
      ).toBeUndefined();
    });
  });

  describe('main plugin — buildStart', () => {
    it('emits SSR entry chunk for Rollup (CJS output)', () => {
      getIsRolldownMock.mockReturnValue(false);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(false),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chunk',
          name: 'ssrRemoteEntry',
          fileName: 'remoteEntry.server.cjs',
        })
      );
    });

    it('emits SSR entry chunk for Rolldown (ESM output)', () => {
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(true),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chunk',
          name: 'ssrRemoteEntry',
          fileName: 'remoteEntry.server.js',
        })
      );
    });

    it('skips emit when no exposes are configured', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions({ exposes: {} }));
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).not.toHaveBeenCalled();
    });

    it('skips emit in non-client environments', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
          environment: { name: 'ssr' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).not.toHaveBeenCalled();
    });

    it('emits in client environment', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
          environment: { name: 'client' },
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalled();
    });

    it('emits when environment name is absent (Rollup)', () => {
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      expect(emitFile).toHaveBeenCalled();
    });
  });

  describe('main plugin — generateBundle (Rollup CJS transform)', () => {
    function runGenerateBundle(code: string) {
      getIsRolldownMock.mockReturnValue(false);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(false),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const chunk = { type: 'chunk' as const, code, fileName: 'remoteEntry.server.cjs' };
      const bundle: Record<string, typeof chunk> = { 'remoteEntry.server.cjs': chunk };

      callHook(
        mainPlugin.generateBundle,
        {} as Rollup.PluginContext,
        {} as Rollup.NormalizedOutputOptions,
        bundle as unknown as Rollup.OutputBundle,
        false
      );

      return chunk.code;
    }

    it('rewrites named ESM imports to CJS require', () => {
      const result = runGenerateBundle(
        `import { init as runtimeInit } from "@module-federation/runtime";`
      );
      expect(result).toContain(
        `const { init as runtimeInit } = require("@module-federation/runtime");`
      );
    });

    it('rewrites default ESM imports to CJS require', () => {
      const result = runGenerateBundle(`import React from "react";`);
      expect(result).toContain(`const React = require("react");`);
    });

    it('rewrites named exports to module.exports', () => {
      const result = runGenerateBundle(`export { init, get };`);
      expect(result).toContain(`module.exports = { init: init, get: get };`);
    });

    it('rewrites re-exported names (as syntax)', () => {
      const result = runGenerateBundle(`export { init as n, get as t };`);
      expect(result).toContain(`module.exports = { n: init, t: get };`);
    });

    it('rewrites default export to module.exports', () => {
      const result = runGenerateBundle(`export default myValue;`);
      expect(result).toContain(`module.exports = myValue;`);
    });

    it("prepends 'use strict' when missing", () => {
      const result = runGenerateBundle(`const x = 1;`);
      expect(result).toMatch(/^'use strict'/);
    });

    it("does not duplicate 'use strict' if already present", () => {
      const result = runGenerateBundle(`'use strict';\nconst x = 1;`);
      expect(result.match(/'use strict'/g)).toHaveLength(1);
    });

    it('leaves Rolldown (ESM) bundle unchanged', () => {
      getIsRolldownMock.mockReturnValue(true);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(true),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const originalCode = `import { init } from "@module-federation/runtime"; export { init };`;
      const chunk = {
        type: 'chunk' as const,
        code: originalCode,
        fileName: 'remoteEntry.server.js',
      };
      const bundle = { 'remoteEntry.server.js': chunk };

      callHook(
        mainPlugin.generateBundle,
        {} as Rollup.PluginContext,
        {} as Rollup.NormalizedOutputOptions,
        bundle as unknown as Rollup.OutputBundle,
        false
      );

      expect(chunk.code).toBe(originalCode);
    });

    it('skips transform when SSR chunk is not in bundle', () => {
      getIsRolldownMock.mockReturnValue(false);
      const emitFile = makeEmitFile();
      const plugins = pluginSSRRemoteEntry(makeOptions());
      const mainPlugin = plugins[1];

      callHook(
        mainPlugin.buildStart,
        {
          meta: makePluginMeta(false),
          emitFile,
        } as unknown as Rollup.PluginContext,
        {} as Rollup.NormalizedInputOptions
      );

      const bundle = {};
      expect(() =>
        callHook(
          mainPlugin.generateBundle,
          {} as Rollup.PluginContext,
          {} as Rollup.NormalizedOutputOptions,
          bundle as unknown as Rollup.OutputBundle,
          false
        )
      ).not.toThrow();
    });
  });
});
