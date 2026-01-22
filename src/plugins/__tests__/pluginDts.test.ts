import type { ResolvedConfig } from 'vite';
import { normalizeModuleFederationOptions } from '../../utils/normalizeModuleFederationOptions';
import pluginDts from '../pluginDts';

describe('pluginDts build', () => {
  it('does not throw when dts options are invalid', async () => {
    const normalized = normalizeModuleFederationOptions({
      name: 'test-module',
      shareStrategy: 'loaded-first',
    });
    normalized.dts = {
      displayErrorInTerminal: false,
      generateTypes: 123,
    } as unknown as typeof normalized.dts;

    const plugins = pluginDts(normalized);
    const buildPlugin = plugins.find((plugin) => plugin.name === 'module-federation-dts-build');
    expect(buildPlugin).toBeTruthy();

    const config = {
      root: process.cwd(),
      build: { outDir: 'dist' },
    } as ResolvedConfig;

    buildPlugin?.configResolved?.(config);
    await expect(buildPlugin?.generateBundle?.()).resolves.toBeUndefined();
  });
});
