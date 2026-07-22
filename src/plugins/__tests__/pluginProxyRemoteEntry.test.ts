import type {
  ConfigPluginContext,
  MinimalPluginContextWithoutEnvironment,
  ResolvedConfig,
  Rollup,
} from 'vite';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { addUsedShares, generateHostAutoInitCode, getHostAutoInitPath } from '../../virtualModules';
import pluginProxyRemoteEntry from '../pluginProxyRemoteEntry';

describe('pluginProxyRemoteEntry', () => {
  it('does not treat an HTML proxy query containing host auto-init as the init module', async () => {
    normalizeModuleFederationOptions({ name: 'test' });
    const plugin = pluginProxyRemoteEntry({
      options: getDefaultMockOptions(),
      remoteEntryId: 'virtual:mf-remote-entry',
      virtualExposesId: 'virtual:mf-exposes',
    });
    callHook(
      plugin.config,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );

    const proxyId = `\0virtual:mf-html-entry-proxy?init=${encodeURIComponent(getHostAutoInitPath())}&entry=%2Fsrc%2Fmain.jsx`;
    expect(
      await callHook(plugin.resolveId, {} as Rollup.PluginContext, proxyId, undefined, {
        isEntry: false,
      })
    ).toBeUndefined();
    expect(await callHook(plugin.load, {} as Rollup.PluginContext, proxyId)).toBeUndefined();
  });

  it('keeps dev host-init shared seeds bound to their owning options', () => {
    const optionsA = normalizeModuleFederationOptions({
      name: 'tenant-a',
      shared: { react: { import: false } },
    });
    addUsedShares('react', optionsA);
    const optionsB = normalizeModuleFederationOptions({
      name: 'tenant-b',
      shared: { vue: { import: false } },
    });
    addUsedShares('vue', optionsB);

    const codeA = generateHostAutoInitCode('remoteEntryImport', 'serve', optionsA);

    expect(codeA).toContain('"tenant-a"');
    expect(codeA).toMatch(/await import\("[^"]*\/react\/index\.js"\)/);
    expect(codeA).not.toContain('"tenant-b"');
    expect(codeA).not.toContain('import("vue")');
  });

  it('refreshes nested remote dependencies before generating virtual exposes', async () => {
    normalizeModuleFederationOptions({ name: 'test' });
    const expose = resolve('integration/fixtures/nested-remote-transitive/exposed-widget.js');
    const store = resolve('integration/fixtures/nested-remote-transitive/store.js');
    const plugin = pluginProxyRemoteEntry({
      options: getDefaultMockOptions({
        exposes: { './widget': { import: expose } as any },
        remotes: {
          remoteA: {
            name: 'remoteA',
            entry: 'http://localhost:3001/remoteEntry.js',
            type: 'module',
          },
        },
      }),
      remoteEntryId: 'virtual:mf-remote-entry',
      virtualExposesId: 'virtual:mf-exposes',
    });

    let exposeResolveCalls = 0;
    const context = {
      resolve: async (source: string) => {
        if (source === expose) {
          exposeResolveCalls += 1;
          return { id: expose };
        }
        if (source === './store.js') return { id: store };
        return undefined;
      },
    } as any;

    callHook(
      plugin.config,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    const generated = await callHook(plugin.load, context, 'virtual:mf-exposes');

    expect(generated).toMatch(
      /__loadRemote__remoteA_mf_1_shared_mf_1_helpers__mf_owner__\d+__loadRemote__/
    );
    await callHook(plugin.load, context, 'virtual:mf-exposes');
    expect(exposeResolveCalls).toBe(1);

    callHook(plugin.watchChange, context, store, { event: 'update' });
    await callHook(plugin.transform, context, '', 'virtual:mf-exposes');
    expect(exposeResolveCalls).toBe(2);
  });

  it('uses an inlined data-URL origin for dev host init in SSR/module-runner contexts, protocol relative fallback origin otherwise', async () => {
    normalizeModuleFederationOptions({ name: 'test' });
    const plugin = pluginProxyRemoteEntry({
      options: getDefaultMockOptions({ filename: 'remoteEntry.js' }),
      remoteEntryId: 'virtual:mf-remote-entry',
      virtualExposesId: 'virtual:mf-exposes',
    });

    callHook(
      plugin.config,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    callHook(
      plugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        root: '/repo',
        base: '/',
        server: { host: '0.0.0.0', port: 4173 },
      } as unknown as ResolvedConfig
    );

    const result = (await callHook(
      plugin.transform,
      {} as Rollup.TransformPluginContext,
      '',
      getHostAutoInitPath()
    )) as {
      code: string;
    };

    expect(result.code).toContain(
      `const origin = typeof window !== 'undefined' && (true) ? window.origin : "//localhost:4173"`
    );
    expect(result.code).toContain(
      `const remoteEntryImport = typeof window !== 'undefined' ? origin + "/remoteEntry.js" : "data:text/javascript,export%20async%20function%20init()%7Breturn%20%7BloadRemote%3Aasync()%3D%3E(%7B%7D)%2CloadShare%3Aasync()%3D%3E(%7B%7D)%7D%7D"`
    );
  });

  it('uses a dev-safe filename for hash-pattern host init remote entry imports', async () => {
    normalizeModuleFederationOptions({ name: 'test' });
    const plugin = pluginProxyRemoteEntry({
      options: getDefaultMockOptions({ filename: 'remoteEntry-[hash]' }),
      remoteEntryId: 'virtual:mf-remote-entry',
      virtualExposesId: 'virtual:mf-exposes',
    });

    callHook(
      plugin.config,
      {} as ConfigPluginContext,
      {},
      { command: 'serve', mode: 'development' }
    );
    callHook(
      plugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        root: '/repo',
        base: '/',
        server: { host: '0.0.0.0', port: 4173 },
      } as unknown as ResolvedConfig
    );

    const result = (await callHook(
      plugin.transform,
      {} as Rollup.TransformPluginContext,
      '',
      getHostAutoInitPath()
    )) as {
      code: string;
    };

    expect(result.code).toContain('origin + "/remoteEntry.js"');
    expect(result.code).not.toContain('remoteEntry-[hash]');
  });

  it('uses an explicitly configured Vite base for dev host init', async () => {
    const plugin = pluginProxyRemoteEntry({
      options: getDefaultMockOptions({ filename: 'remoteEntry.js' }),
      remoteEntryId: 'virtual:mf-remote-entry',
      virtualExposesId: 'virtual:mf-exposes',
    });

    callHook(
      plugin.config,
      {} as ConfigPluginContext,
      { base: '/bbb/' },
      { command: 'serve', mode: 'development' }
    );
    callHook(
      plugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        root: '/repo',
        base: '/bbb/',
        server: { host: 'localhost', port: 4173 },
      } as unknown as ResolvedConfig
    );

    const result = (await callHook(
      plugin.transform,
      {} as Rollup.TransformPluginContext,
      '',
      getHostAutoInitPath()
    )) as { code: string };

    expect(result.code).toContain('origin + "/bbb/remoteEntry.js"');
  });
});
