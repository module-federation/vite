import { describe, expect, it, vi } from 'vitest';
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
      consumeTypes: 123,
    } as unknown as typeof normalized.dts;

    const plugins = pluginDts(normalized);
    const buildPlugin = plugins.find((plugin) => plugin.name === 'module-federation-dts-build');
    expect(buildPlugin).toBeTruthy();

    const config = {
      root: process.cwd(),
      build: { outDir: 'dist' },
    } as ResolvedConfig;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    buildPlugin?.configResolved?.(config);
    await expect(buildPlugin?.generateBundle?.()).resolves.toBeUndefined();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
