import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'vite';
import { getLoadShareImportId } from '../virtualModules/virtualShared_preBuild';

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
import { getPreBuildLibImportId, LOAD_SHARE_TAG } from '../virtualModules';
import { virtualRuntimeInitStatus } from '../virtualModules/virtualRuntimeInitStatus';

function getEsmShimsPlugin(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
  }).find((entry) => entry.name === 'module-federation-esm-shims');

  if (!plugin) throw new Error('module-federation-esm-shims plugin not found');
  return plugin;
}

function getFixPreloadPlugin(): Plugin {
  const plugin = federation({
    name: 'remote',
    filename: 'remoteEntry.js',
    exposes: {
      '.': './src/App.tsx',
    },
  }).find((entry) => entry.name === 'module-federation-fix-preload');

  if (!plugin) throw new Error('module-federation-fix-preload plugin not found');
  return plugin;
}

function getEarlyInitPlugin(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
    shared: {
      vue: {
        singleton: false,
      },
    },
  }).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
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

describe('vite:module-federation-early-init', () => {
  it('skips loadShare optimizeDeps include in Rolldown serve, but keeps prebuild include', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call(
      {
        meta: { rolldownVersion: '1.0.0' },
      } as any,
      config,
      { command: 'serve', mode: 'test' }
    );

    expect(config.optimizeDeps.include).toContain(virtualRuntimeInitStatus.getImportId());
    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).not.toContain(getLoadShareImportId('vue', true, 'serve'));
  });

  it('keeps loadShare optimizeDeps include in non-Rolldown serve', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, { command: 'serve', mode: 'test' });

    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).toContain(getLoadShareImportId('vue', false, 'serve'));
  });
});

function getEarlyInitPluginWithImportFalse(): Plugin {
  const plugin = federation({
    name: 'remote',
    filename: 'remoteEntry.js',
    shared: {
      vue: { singleton: true, import: false },
      pinia: { singleton: true, import: false },
    },
  }).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
  return plugin;
}

describe('vite:module-federation-early-init with import: false', () => {
  it('excludes import: false shared deps from optimizeDeps and prebuild', () => {
    const plugin = getEarlyInitPluginWithImportFalse();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, { command: 'serve', mode: 'test' });

    // Should not include prebuild or loadShare for import: false deps
    const includeStr = config.optimizeDeps.include.join(',');
    expect(includeStr).not.toContain('vue');
    expect(includeStr).not.toContain('pinia');
    // Should still include runtimeInit
    expect(config.optimizeDeps.include).toContain(virtualRuntimeInitStatus.getImportId());
  });
});

function getEarlyInitPluginWithTrailingSlash(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
    shared: {
      'ag-grid-community/': {
        singleton: true,
      },
    },
  }).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
  return plugin;
}

describe('vite:module-federation-early-init with trailing-slash keys', () => {
  it('registers preBuild but not loadShare in Rolldown serve', () => {
    const plugin = getEarlyInitPluginWithTrailingSlash();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call(
      {
        meta: { rolldownVersion: '1.0.0' },
      } as any,
      config,
      { command: 'serve', mode: 'test' }
    );

    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('ag-grid-community'));
    expect(config.optimizeDeps.include).not.toContain(
      getLoadShareImportId('ag-grid-community', true, 'serve')
    );
  });

  it('registers both preBuild and loadShare in non-Rolldown serve', () => {
    const plugin = getEarlyInitPluginWithTrailingSlash();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, { command: 'serve', mode: 'test' });

    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('ag-grid-community'));
    expect(config.optimizeDeps.include).toContain(
      getLoadShareImportId('ag-grid-community', false, 'serve')
    );
  });

  it('excludes trailing-slash import: false deps from optimizeDeps and prebuild', () => {
    const plugin = federation({
      name: 'remote',
      filename: 'remoteEntry.js',
      shared: {
        'vue/': { singleton: true, import: false },
      },
    }).find((entry) => entry.name === 'vite:module-federation-early-init')!;

    const config: any = {
      root: process.cwd(),
      optimizeDeps: { include: [] },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, { command: 'serve', mode: 'test' });

    const includeStr = config.optimizeDeps.include.join(',');
    expect(includeStr).not.toContain('vue');
    expect(config.optimizeDeps.include).toContain(virtualRuntimeInitStatus.getImportId());
  });
});

describe('module-federation-fix-preload', () => {
  it('keeps nested output paths working', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'static/js/preload-helper-abc.js': {
        type: 'chunk',
        fileName: 'static/js/preload-helper-abc.js',
        code: 'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload',
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['static/js/preload-helper-abc.js'].code).toContain(
      'new URL("..\\u002F..\\u002F"+e,import.meta.url).href'
    );
  });

  it('keeps root output paths working', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': {
        type: 'chunk',
        fileName: 'preload-helper-abc.js',
        code: 'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload',
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['preload-helper-abc.js'].code).toContain('new URL(e,import.meta.url).href');
  });
});
