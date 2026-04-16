import type { Plugin } from 'vite';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLoadShareImportId } from '../virtualModules/virtualShared_preBuild';

const { hasPackageDependencyMock, mfWarn } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn(() => false),
  mfWarn: vi.fn(),
}));

vi.mock('../utils/packageUtils', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/packageUtils')>('../utils/packageUtils');
  return {
    ...actual,
    hasPackageDependency: hasPackageDependencyMock,
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

function getFixPreloadPluginWithManifest(manifest: unknown): Plugin {
  const plugin = federation({
    name: 'remote',
    filename: 'remoteEntry.js',
    exposes: {
      '.': './src/App.tsx',
    },
    manifest,
  }).find((entry) => entry.name === 'module-federation-fix-preload');

  if (!plugin) throw new Error('module-federation-fix-preload plugin not found');
  return plugin;
}

function getEarlyInitPlugin(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
    remotes: {
      remoteApp: {
        type: 'module',
        name: 'remoteApp',
        entry: 'http://localhost:4174/remoteEntry.js',
        shareScope: 'default',
      },
    },
    shared: {
      vue: {
        singleton: false,
      },
    },
  }).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
  return plugin;
}

function getEarlyInitPluginWithLitShare(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
    shared: {
      lit: {
        singleton: true,
      },
      'lit/directives/class-map.js': {
        singleton: true,
      },
    },
  }).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
  return plugin;
}

function getModuleFederationVitePlugin(): Plugin {
  const plugin = federation({
    name: 'host',
    filename: 'remoteEntry.js',
  }).find((entry) => entry.name === 'module-federation-vite');

  if (!plugin) throw new Error('module-federation-vite plugin not found');
  return plugin;
}

describe('federation in test environment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns empty plugin array when in test environment', () => {
    process.env.NODE_ENV = 'test';
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
    });
    expect(plugins).toEqual([]);
  });

  it('returns plugins when MFE_VITE_NO_TEST_ENV_CHECK is true', () => {
    process.env.NODE_ENV = 'test';
    process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true';
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
    });
    expect(plugins.length).toBeGreaterThan(0);
  });
});

describe('module-federation-esm-shims', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPackageDependencyMock.mockReturnValue(false);
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

  it('ignores user manualChunks and warns, keeps federation chunks isolated', () => {
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

    // Federation chunks are still isolated
    expect(functionOutput.manualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(functionOutput.manualChunks(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    // User's manualChunks is ignored — non-federation modules return undefined
    expect(functionOutput.manualChunks('/src/custom.ts')).toBeUndefined();

    expect(
      (objectOutput.manualChunks as unknown as Function)('/src/react/index.ts')
    ).toBeUndefined();
    expect(
      (objectOutput.manualChunks as unknown as Function)('/src/other/index.ts')
    ).toBeUndefined();

    // Warning was emitted (once for both outputs)
    expect(mfWarn).toHaveBeenCalled();
  });

  it('does not warn when config() is executed twice for patched output', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rollupOptions: { output: {} },
        rolldownOptions: { output: {} },
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({} as any, config, { command: 'build', mode: 'test' });
    const warnCountAfterFirstRun = mfWarn.mock.calls.length;
    configHook?.call({} as any, config, { command: 'build', mode: 'test' });
    expect(mfWarn).toHaveBeenCalledTimes(warnCountAfterFirstRun);
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
    configHook?.call({ meta: {} } as any, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).toContain(getLoadShareImportId('vue', false, 'serve'));
  });

  it('excludes lit shared ids from optimizeDeps in serve', () => {
    const plugin = getEarlyInitPluginWithLitShare();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.exclude).toContain('lit');
    expect(config.optimizeDeps.exclude).toContain('lit/directives/class-map.js');
    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('lit'));
    expect(config.optimizeDeps.include).toContain(
      getPreBuildLibImportId('lit/directives/class-map.js')
    );
    expect(config.optimizeDeps.include).not.toContain(getLoadShareImportId('lit', false, 'serve'));
    expect(config.optimizeDeps.include).not.toContain(
      getLoadShareImportId('lit/directives/class-map.js', false, 'serve')
    );
  });

  it('excludes bare remote ids from optimizeDeps in Rolldown serve', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: { rolldownVersion: '1.0.0' } } as any, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.exclude).toContain('remoteApp');
  });

  it('leaves ENV_TARGET undefined for Astro mixed builds', () => {
    hasPackageDependencyMock.mockImplementation((dependency) => dependency === 'astro');
    const plugin = getModuleFederationVitePlugin();
    const config: any = {
      root: process.cwd(),
      define: {},
      resolve: {
        alias: [],
      },
      build: {
        ssr: true,
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, {
      command: 'build',
      mode: 'test',
    });

    expect(config.define.ENV_TARGET).toBe('undefined');
  });

  it('still sets ENV_TARGET node for non-Astro ssr builds', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getModuleFederationVitePlugin();
    const config: any = {
      root: process.cwd(),
      define: {},
      resolve: {
        alias: [],
      },
      build: {
        ssr: true,
      },
    };

    const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config?.handler;
    configHook?.call({ meta: {} } as any, config, {
      command: 'build',
      mode: 'test',
    });

    expect(config.define.ENV_TARGET).toBe('"node"');
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
    configHook?.call({ meta: {} } as any, config, {
      command: 'serve',
      mode: 'test',
    });

    // Should not include prebuild or loadShare for import: false deps
    const includeStr = config.optimizeDeps.include.join(',');
    expect(includeStr).not.toContain('vue');
    expect(includeStr).not.toContain('pinia');
    // Should still include runtimeInit
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

  it('does not corrupt Stencil getScopeId function', () => {
    const plugin = getFixPreloadPlugin();
    const stencilCode = 'va=(e,t)=>"sc-"+e.$tagName$,Wn=(e,t)=>{};modulepreload';
    const bundle = {
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        code: stencilCode,
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['assets/index.js'].code).toBe(stencilCode);
  });

  it('does not patch preload helper when manifest disables asset analysis', () => {
    const plugin = getFixPreloadPluginWithManifest({
      disableAssetsAnalyze: true,
    });

    plugin.config?.call(
      {} as any,
      {} as any,
      { command: 'build', mode: 'test' } as { command: 'build'; mode: 'test' }
    );

    const originalCode =
      'const u=function(e){return new URL(\"../\"+e,import.meta.url).href};modulepreload';
    const bundle = {
      'preload-helper-abc.js': {
        type: 'chunk',
        fileName: 'preload-helper-abc.js',
        code: originalCode,
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['preload-helper-abc.js'].code).toBe(originalCode);
  });

  it('still patches preload helper when manifest keeps asset analysis enabled', () => {
    const plugin = getFixPreloadPluginWithManifest({
      disableAssetsAnalyze: false,
    });

    plugin.config?.call(
      {} as any,
      {} as any,
      { command: 'build', mode: 'test' } as { command: 'build'; mode: 'test' }
    );

    const originalCode =
      'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload';
    const bundle = {
      'preload-helper-abc.js': {
        type: 'chunk',
        fileName: 'preload-helper-abc.js',
        code: originalCode,
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['preload-helper-abc.js'].code).toContain('new URL(e,import.meta.url).href');
  });
});

describe('module-federation-dev-await-shared-init', () => {
  it('matches pre-bundled files using configured cacheDir', () => {
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
    });

    const configPlugin = plugins.find((entry) => entry.name === 'vite:module-federation-config');
    const awaitPlugin = plugins.find(
      (entry) => entry.name === 'module-federation-dev-await-shared-init'
    );

    if (!configPlugin) throw new Error('vite:module-federation-config plugin not found');
    if (!awaitPlugin) throw new Error('module-federation-dev-await-shared-init plugin not found');

    configPlugin.configResolved?.call(
      {} as any,
      {
        cacheDir: '/Users/project/node_modules/.vite/_myapp_static_/',
      } as any
    );

    const inputCode = 'import "react";\ninit_abc__loadShare__react();\n';
    const output = awaitPlugin.transform?.(
      inputCode,
      '/Users/project/node_modules/.vite/_myapp_static_/deps/react.js?import'
    );
    const outputCode = typeof output === 'string' ? output : output?.code;
    expect(outputCode).toContain('await init_abc__loadShare__react();');
  });

  it.each([
    {
      label: 'when cacheDir is only a substring',
      path: '/tmp/some/other/path/Users/project/node_modules/.vite/_myapp_static_/deps/react.js',
    },
    {
      label: 'outside configured cacheDir',
      path: '/Users/project/src/components/app.ts',
    },
  ])('skips transform for files outside configured cacheDir ($label)', ({ path }) => {
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
    });

    const configPlugin = plugins.find((entry) => entry.name === 'vite:module-federation-config');
    const awaitPlugin = plugins.find(
      (entry) => entry.name === 'module-federation-dev-await-shared-init'
    );

    if (!configPlugin) throw new Error('vite:module-federation-config plugin not found');
    if (!awaitPlugin) throw new Error('module-federation-dev-await-shared-init plugin not found');

    configPlugin.configResolved?.call(
      {} as any,
      {
        cacheDir: '/Users/project/node_modules/.vite/_myapp_static_',
      } as any
    );

    const inputCode = 'import "react";\ninit_abc__loadShare__react();\n';
    const output = awaitPlugin.transform?.(inputCode, path);
    expect(output).toBeUndefined();
  });
});

describe('module-federation-esm-shims preview await insertion', () => {
  it('inserts awaits after the last top-level import, not comment examples', () => {
    const plugin = getEsmShimsPlugin();

    const originalCode = [
      'import{a as init_host__loadShare__react__loadShare__}from"./__loadShare__react.js";',
      'var SemconvStability;',
      '/**',
      '* Usage:',
      '*',
      "*  import {SemconvStability, semconvStabilityFromStr} from '@opentelemetry/instrumentation';",
      '*/',
      '(init_host__loadShare__react__loadShare__(),factory(module));',
    ].join('\n');

    const bundle = {
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        code: originalCode,
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['assets/index.js'].code).toContain(
      'import{a as init_host__loadShare__react__loadShare__}from"./__loadShare__react.js";await init_host__loadShare__react__loadShare__();\nvar SemconvStability;'
    );
    expect(bundle['assets/index.js'].code).toContain(
      "*  import {SemconvStability, semconvStabilityFromStr} from '@opentelemetry/instrumentation';\n*/\n(init_host__loadShare__react__loadShare__(),factory(module));"
    );
  });

  it('inserts awaits after the last import in one-line minified chunks', () => {
    const plugin = getEsmShimsPlugin();

    const originalCode = [
      'import{a as init_react__loadShare__}from"./react__loadShare__.js";',
      'import{b as init_dom__loadShare__}from"./react-dom__loadShare__.js";',
      '(init_react__loadShare__(),factory(module));',
      '(init_dom__loadShare__(),factory(module));',
    ].join('');

    const bundle = {
      'assets/index.js': {
        type: 'chunk',
        fileName: 'assets/index.js',
        code: originalCode,
      },
    };

    plugin.generateBundle?.call({} as any, {} as any, bundle as any);

    expect(bundle['assets/index.js'].code).toContain(
      'import{a as init_react__loadShare__}from"./react__loadShare__.js";import{b as init_dom__loadShare__}from"./react-dom__loadShare__.js";await init_react__loadShare__();await init_dom__loadShare__();(init_react__loadShare__(),factory(module));(init_dom__loadShare__(),factory(module));'
    );
  });
});
