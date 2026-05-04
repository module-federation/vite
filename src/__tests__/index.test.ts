import type {
  ConfigEnv,
  ConfigPluginContext,
  MinimalPluginContextWithoutEnvironment,
  Plugin,
  Rollup,
  UserConfig,
  ViteBuilder,
} from 'vite';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLoadShareImportId,
  getLoadShareModulePath,
} from '../virtualModules/virtualShared_preBuild';
import type { PluginManifestOptions } from '../utils/normalizeModuleFederationOptions';

const { hasPackageDependencyMock, mfWarn } = vi.hoisted(() => ({
  hasPackageDependencyMock: vi.fn<(dependency: string) => boolean>((_dependency: string) => false),
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

type FederationPlugin = Plugin;
function createChunk(fileName: string, code: string): Rollup.OutputBundle[string] {
  return {
    type: 'chunk',
    fileName,
    name: fileName,
    code,
    map: null,
    preliminaryFileName: fileName,
    sourcemapFileName: null,
    facadeModuleId: null,
    isDynamicEntry: false,
    isEntry: false,
    moduleIds: [],
    exports: [],
    modules: {},
    dynamicImports: [],
    imports: [],
  } as unknown as Rollup.OutputBundle[string];
}

function getEsmShimsPlugin(): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-esm-shims');

  if (!plugin) throw new Error('module-federation-esm-shims plugin not found');
  return plugin;
}

function getFixPreloadPlugin(): FederationPlugin {
  const plugin = (
    federation({
      name: 'remote',
      filename: 'remoteEntry.js',
      exposes: {
        '.': './src/App.tsx',
      },
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-fix-preload');

  if (!plugin) throw new Error('module-federation-fix-preload plugin not found');
  return plugin;
}

function getFixPreloadPluginWithManifest(manifest: PluginManifestOptions): FederationPlugin {
  const plugin = (
    federation({
      name: 'remote',
      filename: 'remoteEntry.js',
      exposes: {
        '.': './src/App.tsx',
      },
      manifest,
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-fix-preload');

  if (!plugin) throw new Error('module-federation-fix-preload plugin not found');
  return plugin;
}

function getVinextFixRscPreloadAsPlugin(): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-vinext-fix-rsc-preload-as');

  if (!plugin) throw new Error('module-federation-vinext-fix-rsc-preload-as plugin not found');
  return plugin;
}

function getEarlyInitPlugin(): FederationPlugin {
  const plugin = (
    federation({
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
    }) as Plugin[]
  ).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
  return plugin;
}

function getEarlyInitPluginWithReactShared(): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
      shared: {
        react: {
          singleton: true,
        },
      },
    }) as Plugin[]
  ).find((entry) => entry.name === 'vite:module-federation-early-init');

  if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');
  return plugin;
}

function getModuleFederationVitePlugin(): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-vite');

  if (!plugin) throw new Error('module-federation-vite plugin not found');
  return plugin;
}

function runConfig(
  plugin: FederationPlugin,
  ctx: ConfigPluginContext,
  config: UserConfig,
  env: ConfigEnv
): void {
  const hook = plugin.config;
  if (!hook) throw new Error(`${plugin.name} config hook not found`);
  if (typeof hook === 'function') {
    hook.call(ctx, config, env);
    return;
  }
  hook.handler.call(ctx, config, env);
}

async function runBuildApp(
  plugin: FederationPlugin,
  ctx: MinimalPluginContextWithoutEnvironment,
  builder: ViteBuilder
): Promise<void> {
  const hook = plugin.buildApp;
  if (!hook) throw new Error(`${plugin.name} buildApp hook not found`);
  if (typeof hook === 'function') {
    await hook.call(ctx, builder);
    return;
  }
  await hook.handler.call(ctx, builder);
}

function runGenerateBundle(
  plugin: FederationPlugin,
  ctx: Rollup.PluginContext,
  outputOptions: Rollup.NormalizedOutputOptions,
  bundle: Rollup.OutputBundle,
  isWrite = false
): void {
  const hook = plugin.generateBundle;
  if (!hook) throw new Error(`${plugin.name} generateBundle hook not found`);
  if (typeof hook === 'function') {
    hook.call(ctx, outputOptions, bundle, isWrite);
    return;
  }
  hook.handler.call(ctx, outputOptions, bundle, isWrite);
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

  it('filters federation control chunks from html modulepreload deps', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {},
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const deps = config.build.modulePreload.resolveDependencies(
      'mf-entry-bootstrap-0.js',
      [
        'assets/index.js',
        'assets/rolldown-runtime-abc.js',
        'assets/preload-helper-abc.js',
        'assets/dist-abc.js',
        'assets/__mfe_internal__host__H_A_I__hostAutoInit__H_A_I__-abc.js',
        'assets/virtual_mf-REMOTE_ENTRY_ID__remoteEntry_js-abc.js',
      ],
      { hostId: 'index.html', hostType: 'html' }
    );

    expect(deps).toEqual(['assets/index.js']);
  });

  it('filters federation control chunks from js dynamic modulepreload deps', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {},
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const deps = config.build.modulePreload.resolveDependencies(
      'assets/index.js',
      [
        'assets/feature.js',
        'assets/__mfe_internal__host__loadRemote__remote_app__loadRemote__-abc.js',
        'assets/hostInit-abc.js',
        'assets/preload-helper-abc.js',
      ],
      { hostId: 'assets/index.js', hostType: 'js' }
    );

    expect(deps).toEqual(['assets/feature.js']);
  });

  it('keeps non-federation html modulepreload deps', () => {
    const plugin = getEsmShimsPlugin();
    const existingResolveDependencies = vi.fn((_filename, deps) => [...deps, 'assets/extra.js']);
    const config: any = {
      build: {
        modulePreload: {
          resolveDependencies: existingResolveDependencies,
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const deps = config.build.modulePreload.resolveDependencies(
      'index.js',
      ['assets/rolldown-runtime-abc.js', 'assets/preload-helper-abc.js'],
      { hostId: 'index.html', hostType: 'html' }
    );

    expect(existingResolveDependencies).toHaveBeenCalled();
    expect(deps).toEqual([
      'assets/rolldown-runtime-abc.js',
      'assets/preload-helper-abc.js',
      'assets/extra.js',
    ]);
  });

  it('removes codeSplitting false and warns once', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rollupOptions: { output: { codeSplitting: false } },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    expect(config.build.rollupOptions.output.codeSplitting).toBeUndefined();
    expect(config.build.rolldownOptions.output.codeSplitting).toBeUndefined();
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('removes codeSplitting groups and warns once', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  test: /node_modules\/(react|react-dom)(\/|$)/,
                  name: 'react',
                },
              ],
            },
          },
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

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

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    // Federation chunks are still isolated
    expect(functionOutput.manualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(functionOutput.manualChunks(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    // User's manualChunks is ignored — non-federation modules return undefined
    expect(functionOutput.manualChunks('/src/custom.ts')).toBeUndefined();

    const objectManualChunks: unknown = objectOutput.manualChunks;
    expect(typeof objectManualChunks).toBe('function');
    if (typeof objectManualChunks !== 'function') {
      throw new Error('manualChunks should be patched into a function');
    }
    expect(objectManualChunks('/src/react/index.ts')).toBeUndefined();
    expect(objectManualChunks('/src/other/index.ts')).toBeUndefined();

    // Warning was emitted (once for both outputs)
    expect(mfWarn).toHaveBeenCalled();
  });

  it('patches manualChunks and removes codeSplitting groups for rolldown output arrays', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const config: any = {
      build: {
        rolldownOptions: {
          output: [
            {
              codeSplitting: {
                groups: [
                  {
                    test: /node_modules\/(react|react-dom)(\/|$)/,
                    name: 'react',
                  },
                ],
              },
            },
            {
              manualChunks: {
                vendor: ['react'],
              },
            },
          ],
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    expect(config.build.rolldownOptions.output[0].codeSplitting).toBeUndefined();
    const patchedManualChunks = config.build.rolldownOptions.output[1].manualChunks;
    expect(typeof patchedManualChunks).toBe('function');
    if (typeof patchedManualChunks !== 'function') {
      throw new Error('manualChunks should be patched into a function');
    }
    expect(patchedManualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(patchedManualChunks(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    expect(patchedManualChunks('/src/other/index.ts')).toBeUndefined();
    expect(mfWarn).toHaveBeenCalledTimes(2);
  });

  it('does not warn when config() is executed twice for patched output', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rollupOptions: { output: {} },
        rolldownOptions: { output: {} },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });
    const warnCountAfterFirstRun = mfWarn.mock.calls.length;
    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });
    expect(mfWarn).toHaveBeenCalledTimes(warnCountAfterFirstRun);
  });

  it('reapplies patched rolldown output in buildApp after Vite overwrites it', async () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rolldownOptions: {
          output: {
            entryFileNames: 'static/js/[name]-[hash].js',
            chunkFileNames: 'static/js/[name]-[hash].js',
            assetFileNames: 'static/[ext]/[name]-[hash].[ext]',
          },
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const overwrittenOutput = {
      entryFileNames: 'assets/[name].js',
      chunkFileNames: 'assets/[name]-[hash].js',
      assetFileNames: 'assets/[name]-[hash][extname]',
      minify: false,
      sourcemap: true,
    };

    const environment = {
      getRolldownOptions: vi.fn(async () => ({
        output: overwrittenOutput,
      })),
    };

    await runBuildApp(
      plugin,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        environments: {
          client: environment,
        },
      } as unknown as ViteBuilder
    );

    const restoredOptions = await environment.getRolldownOptions();

    expect(restoredOptions.output.entryFileNames).toBe('static/js/[name]-[hash].js');
    expect(restoredOptions.output.chunkFileNames).toBe('static/js/[name]-[hash].js');
    expect(restoredOptions.output.assetFileNames).toBe('static/[ext]/[name]-[hash].[ext]');
    expect(restoredOptions.output.minify).toBe(false);
    expect(restoredOptions.output.sourcemap).toBe(true);
  });

  it('reapplies patched rolldown output for output arrays in buildApp', async () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rolldownOptions: {
          output: [
            {
              entryFileNames: 'static/js/[name]-[hash].js',
            },
            {
              chunkFileNames: 'static/chunks/[name]-[hash].js',
              assetFileNames: 'static/assets/[name]-[hash].[ext]',
            },
          ],
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const environment = {
      getRolldownOptions: vi.fn(async () => ({
        output: [
          {
            entryFileNames: 'assets/[name].js',
            minify: false,
          },
          {
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
            sourcemap: true,
          },
        ],
      })),
    };

    await runBuildApp(
      plugin,
      {} as MinimalPluginContextWithoutEnvironment,
      {
        environments: {
          client: environment,
        },
      } as unknown as ViteBuilder
    );

    const restoredOptions = await environment.getRolldownOptions();

    expect(restoredOptions.output[0].entryFileNames).toBe('static/js/[name]-[hash].js');
    expect(restoredOptions.output[0].minify).toBe(false);
    expect(restoredOptions.output[1].chunkFileNames).toBe('static/chunks/[name]-[hash].js');
    expect(restoredOptions.output[1].assetFileNames).toBe('static/assets/[name]-[hash].[ext]');
    expect(restoredOptions.output[1].sourcemap).toBe(true);
  });
});

describe('vite:module-federation-early-init', () => {
  it('adds federation generated files to dev server watch ignores in serve', () => {
    const plugin = getEarlyInitPlugin();
    const customIgnored = '**/custom/**';
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      server: {
        watch: {
          ignored: [customIgnored],
        },
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.server.watch.ignored[0]).toBe(customIgnored);
    const federationIgnored = config.server.watch.ignored[1] as (file: string) => boolean;
    expect(federationIgnored('/repo/node_modules/vue/index.js')).toBe(true);
    expect(federationIgnored('/repo/src/__mf__virtual/loadShare.js')).toBe(true);
    expect(federationIgnored('/repo/.vite/deps/vue.js')).toBe(true);
    expect(federationIgnored('/repo/src/App.vue')).toBe(false);
  });

  it('skips loadShare optimizeDeps include in Rolldown serve, but keeps prebuild include', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    runConfig(
      plugin,
      {
        meta: { rolldownVersion: '1.0.0' },
      } as ConfigPluginContext,
      config,
      { command: 'serve', mode: 'test' }
    );

    expect(config.optimizeDeps.include).toContain(virtualRuntimeInitStatus.getImportId());
    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).not.toContain(getLoadShareImportId('vue', true));
  });

  it('proxies shared deps during Rolldown optimizeDeps resolution', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    runConfig(
      plugin,
      {
        meta: { rolldownVersion: '1.0.0' },
      } as ConfigPluginContext,
      config,
      { command: 'serve', mode: 'test' }
    );

    const resolver = config.optimizeDeps.rolldownOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-resolver'
    );

    expect(resolver.resolveId('vue', '/repo/node_modules/some-lib/index.js')).toEqual({
      id: expect.stringContaining(LOAD_SHARE_TAG),
      external: true,
    });
    expect(resolver.resolveId('react', '/repo/node_modules/react-dom/cjs/react-dom.js')).toBe(
      undefined
    );
  });

  it('keeps loadShare optimizeDeps include in non-Rolldown serve', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).toContain(getLoadShareImportId('vue', false));
  });

  it('redirects System.register commonjs-proxy consumers to loadShare chunks', () => {
    const plugin = getEsmShimsPlugin();
    const proxyFileName = `assets/host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js_commonjs-proxy-abc.js`;
    const loadShareFileName = `./host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js-def.js`;
    const consumerFileName = `assets/host${LOAD_SHARE_TAG}react_mf_2_dom${LOAD_SHARE_TAG}.js-ghi.js`;
    const bundle = {
      [proxyFileName]: createChunk(
        proxyFileName,
        `System.register(["${loadShareFileName}"], (function(exports, module) {
  "use strict";
  var React4;
  return {
    setters: [(module2) => {
      React4 = module2.R;
    }],
    execute: (function() {
      exports({
        a: getDefaultExportFromCjs,
        g: getAugmentedNamespace
      });
      function getDefaultExportFromCjs(x) {
        return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
      }
      function getAugmentedNamespace(n) {
        return n;
      }
      const require$$0 = exports("r", getAugmentedNamespace(React4));
    })
  };
}));`
      ),
      [consumerFileName]: createChunk(
        consumerFileName,
        `System.register(["./host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js_commonjs-proxy-abc.js"], (function(exports, module) {
  "use strict";
  var getAugmentedNamespace, require$$1;
  return {
    setters: [(module2) => {
      getAugmentedNamespace = module2.g;
      require$$1 = module2.r;
    }],
    execute: (function() {
      const ns = getAugmentedNamespace(require$$1);
      exports("n", ns);
    })
  };
}));`
      ),
    } as unknown as Rollup.OutputBundle;

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle
    );

    const consumer = bundle[consumerFileName];
    if (consumer.type !== 'chunk') throw new Error('consumer should be a chunk');

    expect(consumer.code).toContain(JSON.stringify(loadShareFileName));
    expect(consumer.code).not.toContain('commonjs-proxy');
    expect(consumer.code).toContain('function getAugmentedNamespace(n)');
    expect(consumer.code).toContain('require$$1 = module2.R;');
    expect(consumer.code).not.toContain('module2.r');
    expect(consumer.code).not.toContain('getAugmentedNamespace = module2.g');
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

    runConfig(plugin, { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.exclude).toContain('remoteApp');
  });

  it('excludes bare remote ids even when they match installed packages', () => {
    const plugin: Plugin | undefined = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        remotes: {
          scheduler: {
            type: 'module',
            name: 'scheduler',
            entry: 'http://localhost:4175/remoteEntry.js',
            shareScope: 'default',
          },
        },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');

    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    runConfig(plugin, { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.exclude).toContain('scheduler');
    expect(config.optimizeDeps.include).not.toContain('/repo/node_modules/scheduler/index.js');
  });

  it('skips require calls in Rolldown optimizeDeps shared resolver', () => {
    const plugin = getEarlyInitPluginWithReactShared();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
    };

    runConfig(plugin, { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const resolver = config.optimizeDeps.rolldownOptions.plugins.find(
      (entry: { name: string }) => entry.name === 'module-federation:optimize-shared-resolver'
    );
    if (!resolver) throw new Error('optimize shared resolver not found');

    expect(
      resolver.resolveId('react/jsx-runtime', '/repo/src/App.cjs', { kind: 'require-call' })
    ).toBeUndefined();
    expect(resolver.resolveId('react/jsx-runtime', '/repo/src/App.tsx')).toEqual({
      id: getLoadShareModulePath('react/jsx-runtime', true),
      external: true,
    });
  });

  it('leaves ENV_TARGET undefined for Astro mixed builds', () => {
    hasPackageDependencyMock.mockImplementation(
      (dependency: string): boolean => dependency === 'astro'
    );
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

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
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

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'build',
      mode: 'test',
    });

    expect(config.define.ENV_TARGET).toBe('"node"');
  });

  it('does not include virtual module dir or needsInterop for Rolldown optimizeDeps', () => {
    const plugin = getModuleFederationVitePlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      resolve: {
        alias: [],
      },
    };

    runConfig(plugin, { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toContain('@module-federation/runtime');
    expect(config.optimizeDeps.include).not.toContain('__mf__virtual');
    expect(config.optimizeDeps.needsInterop).toBeUndefined();
  });
});

function getEarlyInitPluginWithImportFalse(): Plugin {
  const plugin: Plugin | undefined = (
    federation({
      name: 'remote',
      filename: 'remoteEntry.js',
      shared: {
        vue: { singleton: true, import: false },
        pinia: { singleton: true, import: false },
      },
    }) as Plugin[]
  ).find((entry) => entry.name === 'vite:module-federation-early-init');

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

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
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
      'static/js/preload-helper-abc.js': createChunk(
        'static/js/preload-helper-abc.js',
        'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload'
      ),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['static/js/preload-helper-abc.js'] as Rollup.OutputChunk).code).toContain(
      'new URL("..\\u002F..\\u002F"+e,import.meta.url).href'
    );
  });

  it('keeps root output paths working', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': createChunk(
        'preload-helper-abc.js',
        'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload'
      ),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['preload-helper-abc.js'] as Rollup.OutputChunk).code).toContain(
      'new URL(e,import.meta.url).href'
    );
  });

  it('does not corrupt Stencil getScopeId function', () => {
    const plugin = getFixPreloadPlugin();
    const stencilCode = 'va=(e,t)=>"sc-"+e.$tagName$,Wn=(e,t)=>{};modulepreload';
    const bundle = {
      'assets/index.js': createChunk('assets/index.js', stencilCode),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['assets/index.js'] as Rollup.OutputChunk).code).toBe(stencilCode);
  });

  it('does not patch preload helper when manifest disables asset analysis', () => {
    const plugin = getFixPreloadPluginWithManifest({
      disableAssetsAnalyze: true,
    });

    runConfig(plugin, {} as ConfigPluginContext, {}, { command: 'build', mode: 'test' });

    const originalCode =
      'const u=function(e){return new URL(\"../\"+e,import.meta.url).href};modulepreload';
    const bundle = {
      'preload-helper-abc.js': createChunk('preload-helper-abc.js', originalCode),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['preload-helper-abc.js'] as Rollup.OutputChunk).code).toBe(originalCode);
  });

  it('still patches preload helper when manifest keeps asset analysis enabled', () => {
    const plugin = getFixPreloadPluginWithManifest({
      disableAssetsAnalyze: false,
    });

    runConfig(plugin, {} as ConfigPluginContext, {}, { command: 'build', mode: 'test' });

    const originalCode =
      'const u=function(e){return new URL("../"+e,import.meta.url).href};modulepreload';
    const bundle = {
      'preload-helper-abc.js': createChunk('preload-helper-abc.js', originalCode),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['preload-helper-abc.js'] as Rollup.OutputChunk).code).toContain(
      'new URL(e,import.meta.url).href'
    );
  });

  it('handles backticks in function expression pattern', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': createChunk(
        'preload-helper-abc.js',
        'const u=function(e){return`../`+e};modulepreload'
      ),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['preload-helper-abc.js'] as Rollup.OutputChunk).code).toContain(
      'new URL(e,import.meta.url).href'
    );
  });

  it('handles backticks in arrow function pattern', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': createChunk(
        'preload-helper-abc.js',
        'const u=e=>`../`+e;modulepreload'
      ),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['preload-helper-abc.js'] as Rollup.OutputChunk).code).toContain(
      'new URL(e,import.meta.url).href'
    );
  });
});

describe('module-federation-vinext-fix-rsc-preload-as', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPackageDependencyMock.mockImplementation(
      (dependency: string): boolean => dependency === 'vinext'
    );
  });

  it('normalizes stylesheet RSC preload hints to style', () => {
    const plugin = getVinextFixRscPreloadAsPlugin();
    const bundle = {
      'assets/index.js': createChunk(
        'assets/index.js',
        'function mn(t,n,r,e,i,o){switch(e){case 72:switch(r=i[0],i=i.slice(1),t=JSON.parse(i,t._fromJSON),i=kt.d,r){case"L":r=t[0],e=t[1],t.length===3?i.L(r,e,t[2]):i.L(r,e);break}}}'
      ),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['assets/index.js'] as Rollup.OutputChunk).code).toContain(
      'e==="stylesheet"&&(e="style")'
    );
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
      'assets/index.js': createChunk('assets/index.js', originalCode),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['assets/index.js'] as Rollup.OutputChunk).code).not.toContain(
      'await init_host__loadShare__'
    );
    expect((bundle['assets/index.js'] as Rollup.OutputChunk).code).toContain(
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
      'assets/index.js': createChunk('assets/index.js', originalCode),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['assets/index.js'] as Rollup.OutputChunk).code).not.toContain(
      'await init_react__loadShare__'
    );
    expect((bundle['assets/index.js'] as Rollup.OutputChunk).code).not.toContain(
      'await init_dom__loadShare__'
    );
  });
});
