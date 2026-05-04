import type {
  ConfigPluginContext,
  MinimalPluginContextWithoutEnvironment,
  ResolvedConfig,
  Rollup,
} from 'vite';
import { describe, expect, it } from 'vitest';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';
import { callHook } from '../../utils/__tests__/viteHookHelpers';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { getHostAutoInitPath } from '../../virtualModules';
import pluginProxyRemoteEntry from '../pluginProxyRemoteEntry';

describe('pluginProxyRemoteEntry', () => {
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
});
