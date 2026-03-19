import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';

const { mfWarn } = vi.hoisted(() => ({
  mfWarn: vi.fn(),
}));

vi.mock('../utils/packageUtils', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/packageUtils')>('../utils/packageUtils');
  return {
    ...actual,
    hasPackageDependency: () => false,
    setPackageDetectionCwd: vi.fn(),
  };
});

vi.mock('../utils/logger', async () => {
  const actual = await vi.importActual<typeof import('../utils/logger')>('../utils/logger');
  return {
    ...actual,
    mfWarn,
  };
});

import { federation } from '../index';
import { LOAD_SHARE_TAG } from '../virtualModules';
import { virtualRuntimeInitStatus } from '../virtualModules/virtualRuntimeInitStatus';

function getEsmShimsPlugin(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
  }).find((entry) => entry.name === 'module-federation-esm-shims');

  if (!plugin) throw new Error('module-federation-esm-shims plugin not found');
  return plugin;
}

describe('module-federation-esm-shims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes codeSplitting false and warns once', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rollupOptions: { output: { codeSplitting: false } },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({} as any, config, { command: 'build', mode: 'test' });

    expect(config.build.rollupOptions.output.codeSplitting).toBeUndefined();
    expect(config.build.rolldownOptions.output.codeSplitting).toBeUndefined();
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('keeps federation chunks isolated and preserves existing manualChunks behavior', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const functionOutput = {
      manualChunks: vi.fn((_id: string) => 'existing-fn-chunk'),
    };
    const objectOutput = {
      manualChunks: {
        vendor: ['react'],
      },
    };
    const config: any = {
      build: {
        rollupOptions: { output: functionOutput },
        rolldownOptions: { output: objectOutput },
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({} as any, config, { command: 'build', mode: 'test' });

    expect(functionOutput.manualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(functionOutput.manualChunks(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    expect(functionOutput.manualChunks('/src/custom.ts')).toBe('existing-fn-chunk');

    expect((objectOutput.manualChunks as unknown as Function)('/src/react/index.ts')).toBe(
      'vendor'
    );
    expect(
      (objectOutput.manualChunks as unknown as Function)('/src/other/index.ts')
    ).toBeUndefined();
  });
});
