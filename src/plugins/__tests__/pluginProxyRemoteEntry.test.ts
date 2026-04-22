import { describe, expect, it } from 'vitest';
import pluginProxyRemoteEntry from '../pluginProxyRemoteEntry';
import { getHostAutoInitPath } from '../../virtualModules';
import { getDefaultMockOptions } from '../../utils/__tests__/helpers';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';

describe('pluginProxyRemoteEntry', () => {
  it('uses an absolute fallback origin for dev host init in SSR/module-runner contexts', async () => {
    normalizeModuleFederationOptions({ name: 'test' });
    const plugin = pluginProxyRemoteEntry({
      options: getDefaultMockOptions({ filename: 'remoteEntry.js' }),
      remoteEntryId: 'virtual:mf-remote-entry',
      virtualExposesId: 'virtual:mf-exposes',
    });

    plugin.config?.({}, { command: 'serve', mode: 'development' });
    plugin.configResolved?.({
      root: '/repo',
      base: '/',
      server: { host: '0.0.0.0', port: 4173 },
    } as any);

    const result = (await plugin.transform?.('', getHostAutoInitPath())) as { code: string };

    expect(result.code).toContain('window.origin : "http://localhost:4173"');
    expect(result.code).not.toContain('window.origin : "//localhost:4173"');
  });
});
