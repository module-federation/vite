import { describe, expect, it } from 'vitest';
import pluginSsrRuntimeInit from '../pluginSsrRuntimeInit';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import { getHostAutoInitPath, writeHostAutoInit } from '../../virtualModules/virtualRemoteEntry';

function getHook<T>(hook: T | { handler: T } | undefined): T {
  if (!hook) throw new Error('hook missing');
  return typeof hook === 'object' && hook !== null && 'handler' in hook
    ? hook.handler
    : (hook as T);
}

describe('pluginSsrRuntimeInit', () => {
  it('falls back to configured remotes when the local import map has no remote array', async () => {
    const options = normalizeModuleFederationOptions({
      name: 'ssr-host',
      remotes: {
        catalog: {
          name: 'catalog',
          type: 'module',
          entry: 'http://localhost:4301/remoteEntry.js',
        },
        checkout: {
          name: 'checkout',
          type: 'module',
          entry: 'http://localhost:4302/remoteEntry.js',
        },
        account: {
          name: 'account',
          type: 'module',
          entry: 'http://localhost:4303/remoteEntry.js',
        },
        insights: {
          name: 'insights',
          type: 'module',
          entry: 'http://localhost:4304/remoteEntry.js',
        },
      },
      dts: false,
      hostInitInjectLocation: 'entry',
      ssrEntryLoader: { strategy: 'temp-file' },
    });
    writeHostAutoInit(undefined, 'serve', options);

    const plugin = pluginSsrRuntimeInit(options)[0];
    (getHook(plugin.config) as Function).call(
      plugin,
      {},
      { command: 'serve', mode: 'development' }
    );
    (plugin.configResolved as Function).call(plugin, { build: { ssr: true } });

    const transform = getHook(plugin.transform) as Function;
    const result = (await transform.call(
      { getModuleInfo: () => null },
      '',
      getHostAutoInitPath(options),
      { ssr: true }
    )) as { code?: string };

    expect(result?.code).toContain(
      'const bootstrapRemotes = Array.isArray(usedRemotes) ? usedRemotes :'
    );
    expect(result?.code).toContain('http://localhost:4301/remoteEntry.js');
    expect(result?.code).toContain('http://localhost:4304/remoteEntry.js');
    expect(result?.code).toContain('const bootstrapRemoteNames = new Set(bootstrapRemotes.map');
    expect(result?.code).toContain("name: 'vite-ssr-application-remote-plugin'");
    expect(result?.code).toContain('plugins: [applicationRemotePlugin,');
  });
});
