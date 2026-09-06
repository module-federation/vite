import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mergeConfig,
  type ConfigEnv,
  type ConfigPluginContext,
  type MinimalPluginContextWithoutEnvironment,
  type Plugin,
  type ResolvedConfig,
  type Rollup,
  type UserConfig,
  type ViteBuilder,
} from 'vite';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callHook } from '../utils/__tests__/viteHookHelpers';
import type {
  ModuleFederationOptions,
  NormalizedModuleFederationOptions,
  PluginManifestOptions,
} from '../utils/normalizeModuleFederationOptions';
import { toViteEncodedId } from '../utils/VirtualModule';
import {
  getLoadShareImportId,
  getLoadShareModulePath,
} from '../virtualModules/virtualShared_preBuild';

const { getSharedExportConditionsMock, hasPackageDependencyMock, mfWarn } = vi.hoisted(() => ({
  getSharedExportConditionsMock: vi.fn(),
  hasPackageDependencyMock: vi.fn<(dependency: string) => boolean>((_dependency: string) => false),
  mfWarn: vi.fn(),
}));

vi.mock('../utils/sharedExportConditions', async () => {
  const actual = await vi.importActual<typeof import('../utils/sharedExportConditions')>(
    '../utils/sharedExportConditions'
  );
  return {
    ...actual,
    getSharedExportConditions: (
      ...args: Parameters<typeof actual.getSharedExportConditions>
    ): ReturnType<typeof actual.getSharedExportConditions> => {
      getSharedExportConditionsMock(...args);
      return actual.getSharedExportConditions(...args);
    },
  };
});

vi.mock('../utils/packageUtils', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/packageUtils')>('../utils/packageUtils');
  return {
    ...actual,
    hasPackageDependency: hasPackageDependencyMock,
    resolveImportPath: vi.fn(actual.resolveImportPath),
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
import { resolveImportPath } from '../utils/packageUtils';
import VirtualModule from '../utils/VirtualModule';
import {
  getPreBuildLibImportId,
  getRemoteEntryId,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
} from '../virtualModules';
import {
  generateLocalSharedImportMap,
  getLocalSharedImportMapPath,
  getResolvedLocalSharedImportMapId,
  getUsedShares,
} from '../virtualModules/virtualRemoteEntry';
import {
  getPreloadRemotes,
  getStaticRemotes,
  getUsedRemotesMap,
} from '../virtualModules/virtualRemotes';
import { virtualRuntimeInitStatus } from '../virtualModules/virtualRuntimeInitStatus';

const REACT_EXAMPLE_ROOT = path.join(process.cwd(), 'examples/vite-vite/vite-host');

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

function getNormalizeOptimizeDepsPlugin(): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
    }) as Plugin[]
  ).find((entry) => entry.name === 'normalizeOptimizeDeps');

  if (!plugin) throw new Error('normalizeOptimizeDeps plugin not found');
  return plugin;
}

function getModuleFederationVitePlugin(): FederationPlugin {
  return getModuleFederationVitePluginWithOptions({});
}

function getVirtualModulesPlugin(): FederationPlugin {
  const plugin = (federation({ name: 'host' }) as Plugin[]).find(
    (entry) => entry.name === 'vite:module-federation-virtual-modules'
  );

  if (!plugin) throw new Error('module federation virtual modules plugin not found');
  return plugin;
}

function getModuleFederationVitePluginWithOptions(
  overrides: Partial<ModuleFederationOptions>
): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
      ...overrides,
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-vite');

  if (!plugin) throw new Error('module-federation-vite plugin not found');
  return plugin;
}

function getModuleFederationVitePluginWithShared(): FederationPlugin {
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
  ).find((entry) => entry.name === 'module-federation-vite');

  if (!plugin) throw new Error('module-federation-vite plugin not found');
  return plugin;
}

function getModuleFederationVitePluginWithImportFalse(implementation?: string): FederationPlugin {
  const plugin = (
    federation({
      name: 'host',
      filename: 'remoteEntry.js',
      implementation,
      shared: {
        react: {
          singleton: true,
          import: false,
        },
      },
    }) as Plugin[]
  ).find((entry) => entry.name === 'module-federation-vite');

  if (!plugin) throw new Error('module-federation-vite plugin not found');
  return plugin;
}

function resolvesQuickly(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
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

describe('virtual module resolution', () => {
  it('invalidates shared export inspections for workspace watcher events', () => {
    const on = vi.fn();

    callHook(
      getVirtualModulesPlugin().configureServer,
      {} as MinimalPluginContextWithoutEnvironment,
      { watcher: { on } } as any
    );

    expect(on.mock.calls.map(([event]) => event)).toEqual(['change', 'add', 'unlink']);
  });

  it('resolves the SSR entry loader from the plugin package', () => {
    const loaderPath = '/plugin/lib/utils/ssrEntryLoader.js';
    const resolverMock = vi.mocked(resolveImportPath);
    const originalImplementation = resolverMock.getMockImplementation();
    resolverMock.mockReturnValue(loaderPath);
    try {
      const resolved = callHook(
        getVirtualModulesPlugin().resolveId as any,
        {} as Rollup.PluginContext,
        '@module-federation/vite/ssrEntryLoader'
      ) as string;

      expect(resolveImportPath).toHaveBeenCalledWith('@module-federation/vite/ssrEntryLoader');
      expect(resolved).toBe(loaderPath);
    } finally {
      resolverMock.mockImplementation(originalImplementation!);
    }
  });

  it('loads the current loadShare module for a stale owner id', () => {
    const plugins = federation({
      name: 'stale-load-host',
      shared: { react: { import: false } },
    }) as Plugin[];
    const earlyInitPlugin = plugins.find(
      (plugin) => plugin.name === 'vite:module-federation-early-init'
    )!;
    const virtualModulesPlugin = plugins.find(
      (plugin) => plugin.name === 'vite:module-federation-virtual-modules'
    )!;
    const options = (
      plugins.find((plugin) => plugin.name === 'module-federation-vite') as Plugin & {
        _options: NormalizedModuleFederationOptions;
      }
    )._options;

    runConfig(
      earlyInitPlugin,
      { meta: {} } as ConfigPluginContext,
      { root: process.cwd() },
      { command: 'serve', mode: 'development' }
    );
    const currentId = getLoadShareModulePath('react', false, options);
    const staleId = currentId.replace(/__mf_owner__\d+/, '__mf_owner__999999');
    const context = {} as Rollup.PluginContext;

    expect(callHook(virtualModulesPlugin.load, context, `\0${staleId}`)).toBe(
      callHook(virtualModulesPlugin.load, context, `\0${currentId}`)
    );
  });
});

describe('module parse wiring', () => {
  it('does not deadlock local shared maps across federation instances', async () => {
    const previousNoTestEnvCheck = process.env.MFE_VITE_NO_TEST_ENV_CHECK;
    process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true';
    let pluginSets: Plugin[][];
    try {
      pluginSets = ['first', 'second'].map(
        (name) =>
          federation({
            name,
            filename: `${name}-remoteEntry.js`,
            shared: { react: { import: false } },
          }) as Plugin[]
      );
    } finally {
      if (previousNoTestEnvCheck === undefined) {
        delete process.env.MFE_VITE_NO_TEST_ENV_CHECK;
      } else {
        process.env.MFE_VITE_NO_TEST_ENV_CHECK = previousNoTestEnvCheck;
      }
    }

    const instances = pluginSets.map((plugins) => {
      const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');
      const parseEnd = plugins.find((plugin) => plugin.name === 'parseEnd');
      const localSharedMap = plugins.find(
        (plugin) => plugin.name === 'generateLocalSharedImportMap'
      );
      const federationOptionsPlugin = plugins.find(
        (plugin) => plugin.name === 'module-federation-vite'
      );
      if (!parseStart || !parseEnd || !localSharedMap || !federationOptionsPlugin) {
        throw new Error('module federation plugins not found');
      }
      const options = (
        federationOptionsPlugin as Plugin & {
          _options: NormalizedModuleFederationOptions;
        }
      )._options;
      return { localSharedMap, options, parseEnd, parseStart };
    });
    const ctx = {} as any;

    for (const instance of instances) {
      await callHook(instance.parseStart.buildStart, ctx, undefined as never);
    }
    for (const observer of instances) {
      callHook(observer.parseStart.load, ctx, '/src/main.ts');
      for (const owner of instances) {
        callHook(observer.parseStart.load, ctx, getResolvedLocalSharedImportMapId(owner.options));
      }
      callHook(observer.parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);
    }

    const pendingMaps = instances.map((instance) =>
      Promise.resolve(
        callHook(
          instance.localSharedMap.load,
          ctx,
          getResolvedLocalSharedImportMapId(instance.options)
        )
      )
    );
    const resolved = await Promise.all(pendingMaps.map(resolvesQuickly));

    // Clean up the parse timers without waiting for the production timeout.
    for (const instance of instances) callHook(instance.parseEnd.buildEnd, ctx);
    await Promise.all(pendingMaps);

    expect(resolved).toEqual([true, true]);
    expect(getLocalSharedImportMapPath(instances[0].options)).not.toBe(
      getLocalSharedImportMapPath(instances[1].options)
    );
  });

  it('does not wait for generated load-share or prebuild modules', async () => {
    const previousNoTestEnvCheck = process.env.MFE_VITE_NO_TEST_ENV_CHECK;
    process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true';
    let plugins: Plugin[];
    try {
      plugins = federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          react: {},
        },
      }) as Plugin[];
    } finally {
      if (previousNoTestEnvCheck === undefined) {
        delete process.env.MFE_VITE_NO_TEST_ENV_CHECK;
      } else {
        process.env.MFE_VITE_NO_TEST_ENV_CHECK = previousNoTestEnvCheck;
      }
    }
    const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');
    const parseEnd = plugins.find((plugin) => plugin.name === 'parseEnd');
    const proxyRemoteEntry = plugins.find((plugin) => plugin.name === 'proxyRemoteEntry');
    const federationOptionsPlugin = plugins.find(
      (plugin) => plugin.name === 'module-federation-vite'
    );
    if (!parseStart || !parseEnd || !proxyRemoteEntry || !federationOptionsPlugin) {
      throw new Error('module federation plugins not found');
    }
    const ctx = {} as any;
    const federationOptions = (
      federationOptionsPlugin as Plugin & {
        _options: NormalizedModuleFederationOptions;
      }
    )._options;

    runConfig(proxyRemoteEntry, {} as ConfigPluginContext, {}, { command: 'build', mode: 'test' });
    callHook(parseStart.buildStart, ctx, undefined as never);
    callHook(parseStart.load, ctx, `virtual:mf:host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js`);
    callHook(parseStart.load, ctx, `virtual:mf:host${PREBUILD_TAG}react${PREBUILD_TAG}.js`);
    callHook(parseStart.load, ctx, '/src/main.ts');
    const pendingRemoteEntry = callHook(
      proxyRemoteEntry.load,
      ctx,
      getRemoteEntryId(federationOptions)
    );

    callHook(parseEnd.moduleParsed, ctx, { id: '/src/main.ts' } as never);

    expect(await Promise.resolve(pendingRemoteEntry)).toEqual(expect.any(String));
  });

  it('keeps the complete import:false export surface when parse analysis is incomplete', async () => {
    const previousNoTestEnvCheck = process.env.MFE_VITE_NO_TEST_ENV_CHECK;
    process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true';
    let plugins: Plugin[];
    try {
      plugins = federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          react: {
            import: false,
            singleton: true,
          },
        },
      }) as Plugin[];
    } finally {
      if (previousNoTestEnvCheck === undefined) {
        delete process.env.MFE_VITE_NO_TEST_ENV_CHECK;
      } else {
        process.env.MFE_VITE_NO_TEST_ENV_CHECK = previousNoTestEnvCheck;
      }
    }

    const earlyInitPlugin = plugins.find(
      (plugin) => plugin.name === 'vite:module-federation-early-init'
    );
    const federationConfigPlugin = plugins.find(
      (plugin) => plugin.name === 'vite:module-federation-config'
    );
    const sharedAnalysisPlugin = plugins.find((plugin) => plugin.name === 'proxyPreBuildShared');
    const parseStart = plugins.find((plugin) => plugin.name === 'parseStart');
    const parseEnd = plugins.find((plugin) => plugin.name === 'parseEnd');
    const federationLoadPlugin = plugins.find(
      (plugin) => plugin.name === 'module-federation-esm-shims'
    );
    const federationOptionsPlugin = plugins.find(
      (plugin) => plugin.name === 'module-federation-vite'
    );
    if (
      !earlyInitPlugin ||
      !federationConfigPlugin ||
      !sharedAnalysisPlugin ||
      !parseStart ||
      !parseEnd ||
      !federationLoadPlugin ||
      !federationOptionsPlugin
    ) {
      throw new Error('module federation plugins not found');
    }

    const config = { root: process.cwd(), build: {} } as UserConfig;
    const env = { command: 'build', mode: 'test' } as ConfigEnv;
    const configContext = { meta: {} } as ConfigPluginContext;
    runConfig(earlyInitPlugin, configContext, config, env);
    runConfig(federationConfigPlugin, configContext, config, env);
    runConfig(sharedAnalysisPlugin, configContext, config, env);

    const parseContext = { resolve: async (id: string) => ({ id }) } as any;
    await callHook(parseStart.buildStart, parseContext, undefined as never);
    callHook(
      sharedAnalysisPlugin.transform,
      {} as any,
      'import { useState } from "react";',
      '/src/main.ts'
    );
    callHook(parseEnd.buildEnd, parseContext);

    const federationOptions = (
      federationOptionsPlugin as Plugin & {
        _options: NormalizedModuleFederationOptions;
      }
    )._options;
    const loadShareId = getLoadShareModulePath('react', false, federationOptions);
    const result = (await callHook(
      federationLoadPlugin.load,
      {} as Rollup.PluginContext,
      loadShareId
    )) as { code: string };

    expect(result.code).toContain('exportModule["useState"]');
    expect(result.code).toContain('exportModule["createElement"]');
  });
});

describe('shared export condition configuration', () => {
  it('uses SSR conditions contributed by a later config hook in Vite 5-7 load hooks', async () => {
    const pkg = 'missing-late-conditions-package';
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
      shared: {
        [pkg]: {
          import: false,
        },
      },
    }) as Plugin[];
    const earlyInitPlugin = plugins.find(
      (plugin) => plugin.name === 'vite:module-federation-early-init'
    );
    const federationConfigPlugin = plugins.find(
      (plugin) => plugin.name === 'vite:module-federation-config'
    );
    const federationOptionsPlugin = plugins.find(
      (plugin) => plugin.name === 'module-federation-vite'
    );
    const federationLoadPlugin = plugins.find(
      (plugin) => plugin.name === 'module-federation-esm-shims'
    );
    if (
      !earlyInitPlugin ||
      !federationConfigPlugin ||
      !federationOptionsPlugin ||
      !federationLoadPlugin
    ) {
      throw new Error('module federation plugins not found');
    }

    const config: UserConfig = {
      root: process.cwd(),
      build: {
        ssr: true,
      },
    };
    const env = {
      command: 'build',
      mode: 'production',
    } as ConfigEnv;
    const configContext = { meta: {} } as ConfigPluginContext;

    runConfig(earlyInitPlugin, configContext, config, env);
    runConfig(federationConfigPlugin, configContext, config, env);

    const lateConditionsPlugin: Plugin = {
      name: 'late-ssr-conditions',
      config() {
        return {
          resolve: {
            conditions: ['late-root-condition'],
          },
          ssr: {
            target: 'webworker',
            resolve: {
              conditions: ['late-ssr-condition'],
            },
          },
        };
      },
    };
    const lateConfig = callHook(lateConditionsPlugin.config, configContext, config, env);
    const resolvedConfig = {
      ...mergeConfig(config, lateConfig ?? {}),
      isProduction: true,
    } as ResolvedConfig;

    callHook(
      federationConfigPlugin.configResolved,
      {} as MinimalPluginContextWithoutEnvironment,
      resolvedConfig
    );

    // Vite 5-7 load hooks have no `this.environment`, so they use the values
    // captured from the final ResolvedConfig above.
    getSharedExportConditionsMock.mockClear();
    const federationOptions = (
      federationOptionsPlugin as Plugin & {
        _options: NonNullable<Parameters<typeof getLoadShareModulePath>[2]>;
      }
    )._options;
    const loadShareId = getLoadShareModulePath(pkg, false, federationOptions);
    await callHook(federationLoadPlugin.load, {} as Rollup.PluginContext, loadShareId, {
      ssr: true,
    });

    expect(getSharedExportConditionsMock).toHaveBeenCalledWith({
      environmentConditions: undefined,
      isProduction: true,
      isSsr: true,
      rootConditions: ['late-root-condition'],
      ssrConditions: ['late-ssr-condition'],
      ssrTarget: 'webworker',
    });
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

  it.each([true, 'src/entry-server.ts'])(
    'prepends workspace singleton imports for legacy SSR build load hooks with build.ssr=%s',
    (ssr) => {
      const plugin = getEsmShimsPlugin();
      const config: any = {
        build: { ssr },
      };
      runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

      const virtualModule = new VirtualModule('legacy-workspace-singleton', LOAD_SHARE_TAG, '.js');
      virtualModule.write(`
      let __mf_default;
      const __mfApplyLazyShareExports = (mod) => {
        __mf_default = mod.default ?? mod;
      };
      if (import.meta.env.SSR) {
        const exportModule = __mfNormalizeShareModule(__mfLocalShare);
        __mfApplyLazyShareExports(exportModule);
      } else {
        initPromise.then(() =>
          import("/repo/packages/workspace-shared-lib/src/index.tsx").then((mod) => {
            const exportModule = __mfNormalizeShareModule(mod);
            __mfApplyLazyShareExports(exportModule);
          })
        );
      }
      export { __mf_default as default };
    `);

      const result = callHook(plugin.load, {} as any, virtualModule.getImportId()) as {
        code: string;
      };

      expect(result.code).toContain(
        'import * as __mfLocalShare from "/repo/packages/workspace-shared-lib/src/index.tsx";'
      );
    }
  );

  it('returns null when build load hook cannot resolve a virtual module', () => {
    const plugin = getEsmShimsPlugin();
    runConfig(plugin, {} as ConfigPluginContext, { build: {} }, { command: 'build', mode: 'test' });
    const result = callHook(
      plugin.load,
      {} as any,
      `/etc/passwd${LOAD_SHARE_TAG}fake${LOAD_SHARE_TAG}.js`
    );
    expect(result).toBeNull();
  });

  it('returns the full shared module to CommonJS consumers', () => {
    const plugin = getEsmShimsPlugin();
    const target = `\0virtual:mf:host${LOAD_SHARE_TAG}cjs-package${LOAD_SHARE_TAG}.js`;
    const result = callHook(plugin.load, {} as any, `\0${target}?commonjs-proxy`);

    expect(result).toBe(`export { __moduleExports as default } from ${JSON.stringify(target)};`);
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

  // Resolves the federation `name(id)` group function installed on an output.
  const federationNameFn = (output: any): ((id: string) => string | null) => {
    const groups = output?.codeSplitting?.groups;
    if (!Array.isArray(groups)) {
      throw new Error('expected federation codeSplitting groups to be installed');
    }
    const group = groups.find((g: any) => typeof g?.name === 'function');
    if (!group) {
      throw new Error('expected a federation name() group');
    }
    return group.name;
  };

  // Resolves the isolated preload-helper group installed on an output.
  const preloadHelperGroup = (output: any): any => {
    const groups = output?.codeSplitting?.groups;
    return Array.isArray(groups)
      ? groups.find((g: any) => g?.name === 'vite-preload-helper')
      : undefined;
  };

  it('removes codeSplitting false, warns once, and installs bundler-appropriate isolation', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const config: any = {
      build: {
        rollupOptions: { output: { codeSplitting: false } },
        rolldownOptions: { output: { codeSplitting: false } },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    // Rollup (Vite 5–7) gets `manualChunks` and never `codeSplitting` (which Rollup
    // rejects as an unknown output option).
    expect(config.build.rollupOptions.output.codeSplitting).toBeUndefined();
    expect(typeof config.build.rollupOptions.output.manualChunks).toBe('function');
    expect(config.build.rollupOptions.output.manualChunks(`/virtual/${runtimeInitId}`)).toBe(
      'runtimeInit'
    );
    // Rolldown (Vite 8+) gets the `codeSplitting` groups and no `manualChunks`.
    expect(Array.isArray(config.build.rolldownOptions.output.codeSplitting.groups)).toBe(true);
    expect(config.build.rolldownOptions.output.manualChunks).toBeUndefined();
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('keeps user codeSplitting groups below the federation groups', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const userGroup = {
      test: /resource-bindings/,
      name: 'resource-bindings',
      priority: 50,
    };
    const config: any = {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [userGroup],
            },
          },
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const groups = config.build.rolldownOptions.output.codeSplitting.groups;
    // User's group survives with its original priority.
    const survivor = groups.find((g: any) => g.name === 'resource-bindings');
    expect(survivor).toEqual(userGroup);
    const helper = preloadHelperGroup(config.build.rolldownOptions.output);
    expect(helper).toBeDefined();
    // Matches Rolldown's injected helper id, not arbitrary user files.
    expect(helper.test.test('\0vite/preload-helper.js')).toBe(true);
    expect(helper.test.test('/src/preload-helper.ts')).toBe(false);
    const federationGroup = groups.find((g: any) => typeof g?.name === 'function');
    expect(federationGroup.name(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    // Federation groups outrank the user group so it can never capture
    // runtimeInit/loadShare/preload modules.
    expect(federationGroup.priority).toBeGreaterThan(survivor.priority);
    expect(helper.priority).toBeGreaterThan(survivor.priority);
    // Keeping user groups is not a conflict — no warning.
    expect(mfWarn).not.toHaveBeenCalled();

    // Running config() again neither duplicates groups nor drops the user group.
    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });
    const groupsAfterRerun = config.build.rolldownOptions.output.codeSplitting.groups;
    expect(groupsAfterRerun).toHaveLength(3);
    expect(groupsAfterRerun.filter((g: any) => g.name === 'resource-bindings')).toHaveLength(1);
  });

  it('clamps user group priority below the federation groups and warns once', () => {
    const plugin = getEsmShimsPlugin();
    const config: any = {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                { test: /vendor/, name: 'greedy', priority: Number.MAX_SAFE_INTEGER },
                { test: /other/, name: 'also-greedy', priority: Number.MAX_SAFE_INTEGER },
              ],
            },
          },
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const groups = config.build.rolldownOptions.output.codeSplitting.groups;
    const federationGroup = groups.find((g: any) => typeof g?.name === 'function');
    const helper = preloadHelperGroup(config.build.rolldownOptions.output);
    for (const name of ['greedy', 'also-greedy']) {
      const clamped = groups.find((g: any) => g.name === name);
      expect(clamped.priority).toBeLessThan(federationGroup.priority);
      expect(clamped.priority).toBeLessThan(helper.priority);
    }
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('keeps a user group whose name collides with the preload-helper group', () => {
    const plugin = getEsmShimsPlugin();
    // A user group that shares the federation preload-helper group's name. It must
    // be matched by object identity, not name, so it isn't silently dropped.
    const userGroup = {
      name: 'vite-preload-helper',
      test: /custom-preload-marker/,
      priority: 50,
    };
    const config: any = {
      build: {
        rolldownOptions: {
          output: { codeSplitting: { groups: [userGroup] } },
        },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    const groups = config.build.rolldownOptions.output.codeSplitting.groups;
    // The name collision no longer drops the user group.
    const survivor = groups.find((g: any) => g.test?.source === 'custom-preload-marker');
    expect(survivor).toEqual(userGroup);
    // The plugin still installs its own preload-helper group; both same-named
    // groups coexist because identity — not name — distinguishes them.
    const federationHelper = groups.find(
      (g: any) => g.name === 'vite-preload-helper' && g.test?.test('\0vite/preload-helper.js')
    );
    expect(federationHelper).toBeDefined();
    expect(federationHelper).not.toBe(survivor);
    expect(federationHelper.priority).toBeGreaterThan(survivor.priority);
    expect(groups.filter((g: any) => g.name === 'vite-preload-helper')).toHaveLength(2);
    // Keeping the user group is not a conflict — no warning.
    expect(mfWarn).not.toHaveBeenCalled();

    // Re-running config() drops the previous federation group (by identity) rather
    // than mistaking it for a user group, so counts stay stable.
    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });
    const rerun = config.build.rolldownOptions.output.codeSplitting.groups;
    expect(rerun.filter((g: any) => g.test?.source === 'custom-preload-marker')).toHaveLength(1);
    expect(rerun.filter((g: any) => g.name === 'vite-preload-helper')).toHaveLength(2);
  });

  it('composes user manualChunks behind federation chunks, keeps federation chunks isolated', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const userManualChunks = vi.fn((_id: string) => 'existing-fn-chunk');
    const functionOutput: any = {
      manualChunks: userManualChunks,
    };
    const objectOutput: any = {
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

    // Rollup output (Vite 5–7): federation modules are claimed first and never
    // reach the user's function.
    expect(functionOutput.codeSplitting).toBeUndefined();
    expect(typeof functionOutput.manualChunks).toBe('function');
    expect(functionOutput.manualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(functionOutput.manualChunks(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    expect(functionOutput.manualChunks('\0vite/preload-helper.js')).toBe('vite-preload-helper');
    expect(userManualChunks).not.toHaveBeenCalled();
    // Non-federation modules fall through to the user's function.
    expect(functionOutput.manualChunks('/src/custom.ts')).toBe('existing-fn-chunk');
    expect(userManualChunks).toHaveBeenCalledWith('/src/custom.ts');

    // Rolldown output (Vite 8+): user's manualChunks is removed in favor of the
    // federation codeSplitting groups, with the preload helper isolated.
    expect(objectOutput.manualChunks).toBeUndefined();
    const nameFn = federationNameFn(objectOutput);
    expect(nameFn(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(nameFn('/src/custom.ts')).toBeNull();
    expect(preloadHelperGroup(objectOutput)).toBeDefined();

    // Only the removed Rolldown manualChunks warns; the composed function does not.
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('ignores the object form of manualChunks on the rollup path and warns', () => {
    const plugin = getEsmShimsPlugin();
    const runtimeInitId = virtualRuntimeInitStatus.getImportId();
    const output: any = {
      manualChunks: { vendor: ['react'] },
    };
    const config: any = {
      build: {
        rollupOptions: { output },
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, { command: 'build', mode: 'test' });

    expect(typeof output.manualChunks).toBe('function');
    expect(output.manualChunks(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(output.manualChunks('/node_modules/react/index.js')).toBeUndefined();
    expect(mfWarn).toHaveBeenCalledTimes(1);
  });

  it('installs federation groups, keeps user groups, and removes manualChunks for rolldown output arrays', () => {
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

    const out0 = config.build.rolldownOptions.output[0];
    const out1 = config.build.rolldownOptions.output[1];
    // User's 'react' group survives on out0, below the federation groups.
    const reactGroup = out0.codeSplitting.groups.find((g: any) => g.name === 'react');
    expect(reactGroup).toBeDefined();
    expect(preloadHelperGroup(out0)).toBeDefined();
    expect(preloadHelperGroup(out0).priority).toBeGreaterThan(reactGroup.priority ?? 0);
    // User's manualChunks removed; federation groups installed on out1.
    expect(out1.manualChunks).toBeUndefined();
    const nameFn = federationNameFn(out1);
    expect(nameFn(`/virtual/${runtimeInitId}`)).toBe('runtimeInit');
    expect(nameFn(`/virtual/react${LOAD_SHARE_TAG}chunk.js`)).toBe(
      `react${LOAD_SHARE_TAG}chunk.js`
    );
    expect(nameFn('/src/other/index.ts')).toBeNull();
    // Only the removed manualChunks on out1 warns.
    expect(mfWarn).toHaveBeenCalledTimes(1);
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
  it('materializes shares imported by the entry graph but leaves configured-only shares lazy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-entry-shares-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/main.ts"></script>'
    );
    writeFileSync(path.join(root, 'src/main.ts'), 'import("./App")');
    writeFileSync(
      path.join(root, 'src/App.tsx'),
      'import React from "react"; export default React'
    );

    try {
      const plugins = federation({
        name: 'entry-shares',
        shared: { react: {}, vue: {} },
      }) as Plugin[];
      const early = plugins.find((plugin) => plugin.name === 'vite:module-federation-early-init');
      const owner = plugins.find((plugin) => plugin.name === 'module-federation-vite') as
        | (Plugin & { _options: NormalizedModuleFederationOptions })
        | undefined;
      if (!early || !owner) throw new Error('module federation plugins not found');

      runConfig(early, { meta: {} } as ConfigPluginContext, { root } as UserConfig, {
        command: 'serve',
        mode: 'test',
      });

      const code = generateLocalSharedImportMap(owner._options);
      expect(code).toMatch(/"react": \{[\s\S]*?materialize: true,/);
      expect(code).toMatch(/"vue": \{[\s\S]*?materialize: false,/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes the automatic JSX runtime a JSX entry graph imports, and its root package', () => {
    // Regression: the entry-graph crawl is textual, and the automatic JSX
    // runtime import is generated by the compiler rather than written in
    // source, so the crawl could never see it. The only other observer is the
    // resolver hook installed into optimizeDeps, which Vite runs only while it
    // scans dependencies - and it skips scanning once node_modules/.vite is
    // warm. On a warm dev server the share stayed unmaterialized, init() never
    // seeded it, and its loadShare wrapper handed the entry an undefined
    // binding (`_jsxDEV is not a function`).
    const root = mkdtempSync(path.join(tmpdir(), 'mf-jsx-runtime-shares-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/main.jsx"></script>'
    );
    // Deliberately names neither react nor its JSX runtime: the only import of
    // either is the one the JSX transform injects.
    writeFileSync(path.join(root, 'src/main.jsx'), 'export default <div />');

    try {
      const plugins = federation({
        name: 'jsx-runtime-shares',
        shared: { react: {}, vue: {} },
      }) as Plugin[];
      const early = plugins.find((plugin) => plugin.name === 'vite:module-federation-early-init');
      const owner = plugins.find((plugin) => plugin.name === 'module-federation-vite') as
        | (Plugin & { _options: NormalizedModuleFederationOptions })
        | undefined;
      if (!early || !owner) throw new Error('module federation plugins not found');

      runConfig(early, { meta: {} } as ConfigPluginContext, { root } as UserConfig, {
        command: 'serve',
        mode: 'test',
      });
      callHook(
        early.configResolved,
        {} as MinimalPluginContextWithoutEnvironment,
        {
          root,
          command: 'serve',
          oxc: { jsx: { runtime: 'automatic', importSource: 'react', development: true } },
        } as ResolvedConfig
      );

      const code = generateLocalSharedImportMap(owner._options);
      expect(code).toMatch(/"react\/jsx-dev-runtime": \{[\s\S]*?materialize: true,/);
      // The subpath is served by its root package, so the root comes with it.
      expect(code).toMatch(/"react": \{[\s\S]*?materialize: true,/);
      // A configured share nothing imports still stays lazy.
      expect(code).toMatch(/"vue": \{[\s\S]*?materialize: false,/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'classic JSX',
      jsx: { runtime: 'classic' },
      shared: { react: {} },
      materialized: [],
      lazy: ['react', 'react/jsx-dev-runtime'],
    },
    {
      name: 'a custom automatic runtime',
      jsx: { runtime: 'automatic', importSource: 'preact', development: true },
      shared: { react: {}, preact: {}, 'preact/jsx-dev-runtime': {} },
      materialized: ['preact', 'preact/jsx-dev-runtime'],
      lazy: ['react', 'react/jsx-dev-runtime'],
    },
  ])('respects $name when materializing JSX shares', ({ jsx, shared, materialized, lazy }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-configured-jsx-runtime-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/main.jsx"></script>'
    );
    writeFileSync(path.join(root, 'src/main.jsx'), 'export default <div />');

    try {
      const plugins = federation({
        name: 'configured-jsx-runtime',
        shared: shared as ModuleFederationOptions['shared'],
      }) as Plugin[];
      const early = plugins.find((plugin) => plugin.name === 'vite:module-federation-early-init');
      const owner = plugins.find((plugin) => plugin.name === 'module-federation-vite') as
        | (Plugin & { _options: NormalizedModuleFederationOptions })
        | undefined;
      if (!early || !owner) throw new Error('module federation plugins not found');

      runConfig(early, { meta: {} } as ConfigPluginContext, { root } as UserConfig, {
        command: 'serve',
        mode: 'test',
      });
      callHook(
        early.configResolved,
        {} as MinimalPluginContextWithoutEnvironment,
        { root, command: 'serve', oxc: { jsx } } as ResolvedConfig
      );

      const code = generateLocalSharedImportMap(owner._options);
      for (const share of materialized) {
        expect(code).toMatch(
          new RegExp(`${share.replace('/', '\\/')}": \\{[\\s\\S]*?materialize: true,`)
        );
      }
      for (const share of lazy) {
        expect(code).toMatch(
          new RegExp(`${share.replace('/', '\\/')}": \\{[\\s\\S]*?materialize: false,`)
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves directory imports in the entry graph to their index file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-entry-dir-import-'));
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'src/provider'));
    writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/main.ts"></script>'
    );
    // A bare directory request: `src/provider` exists as a directory, so reading
    // it as source would fail with EISDIR instead of picking up its index file.
    writeFileSync(path.join(root, 'src/main.ts'), 'import { Provider } from "./provider"');
    writeFileSync(
      path.join(root, 'src/provider/index.ts'),
      'import React from "react"; export const Provider = React'
    );

    try {
      const plugins = federation({
        name: 'entry-dir-import',
        shared: { react: {}, vue: {} },
      }) as Plugin[];
      const early = plugins.find((plugin) => plugin.name === 'vite:module-federation-early-init');
      const owner = plugins.find((plugin) => plugin.name === 'module-federation-vite') as
        | (Plugin & { _options: NormalizedModuleFederationOptions })
        | undefined;
      if (!early || !owner) throw new Error('module federation plugins not found');

      expect(() =>
        runConfig(early, { meta: {} } as ConfigPluginContext, { root } as UserConfig, {
          command: 'serve',
          mode: 'test',
        })
      ).not.toThrow();

      // The directory's index file was crawled, so its react import is materialized.
      const code = generateLocalSharedImportMap(owner._options);
      expect(code).toMatch(/"react": \{[\s\S]*?materialize: true,/);
      expect(code).toMatch(/"vue": \{[\s\S]*?materialize: false,/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers nested static remotes before the first dev load', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-entry-static-remote-'));
    mkdirSync(path.join(root, 'src/store'), { recursive: true });
    writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/main.ts"></script>'
    );
    writeFileSync(path.join(root, 'src/main.ts'), 'import "./store"; import("./lazy")');
    writeFileSync(path.join(root, 'src/store/index.ts'), 'import "modules/authSlice"');
    writeFileSync(path.join(root, 'src/lazy.ts'), 'import "modules/lazy"');

    try {
      const plugins = federation({
        name: 'entry-static-remote',
        remotes: {
          modules: {
            name: 'modules',
            type: 'module',
            entry: '/modules/assets/remoteEntry.js',
          },
        },
      }) as Plugin[];
      const early = plugins.find((plugin) => plugin.name === 'vite:module-federation-early-init');
      const owner = plugins.find((plugin) => plugin.name === 'module-federation-vite') as
        | (Plugin & { _options: NormalizedModuleFederationOptions })
        | undefined;
      if (!early || !owner) throw new Error('module federation plugins not found');

      runConfig(early, { meta: {} } as ConfigPluginContext, { root } as UserConfig, {
        command: 'serve',
        mode: 'test',
      });

      expect([...getUsedRemotesMap(owner._options).modules]).toContain('modules/authSlice');
      expect([...getUsedRemotesMap(owner._options).modules]).not.toContain('modules/lazy');
      expect(getPreloadRemotes(owner._options)).toEqual(new Set(['modules/authSlice']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scans only the configured client entry and ignores type-only or textual imports', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-entry-static-build-'));
    const entry = path.join(root, 'src/entry.ts');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(
      path.join(root, 'index.html'),
      '<script type="module" src="/src/unused.ts"></script>'
    );
    writeFileSync(path.join(root, 'src/unused.ts'), 'import "remote/only-in-index-html";');
    writeFileSync(
      entry,
      [
        '// import "remote/comment";',
        'const text = "import \'remote/string\'";',
        'import type { RemoteType } from "remote/type";',
        'import "remote/runtime";',
        'const lazy = require("remote/commonjs");',
      ].join('\n')
    );

    try {
      const plugins = federation({
        name: 'entry-static-build',
        remotes: {
          remote: {
            name: 'remote',
            type: 'module',
            entry: '/modules/assets/remoteEntry.js',
          },
        },
      }) as Plugin[];
      const early = plugins.find((plugin) => plugin.name === 'vite:module-federation-early-init');
      const owner = plugins.find((plugin) => plugin.name === 'module-federation-vite') as
        | (Plugin & { _options: NormalizedModuleFederationOptions })
        | undefined;
      if (!early || !owner) throw new Error('module federation plugins not found');

      runConfig(
        early,
        { meta: {} } as ConfigPluginContext,
        {
          root,
          build: { rollupOptions: { input: entry } },
        } as UserConfig,
        {
          command: 'build',
          mode: 'production',
        }
      );

      expect(getStaticRemotes(owner._options)).toEqual(new Set(['remote/runtime']));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stabilizes optimizer inputs before dependency scanning', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: ['z-last', 'vue', 'z-last'],
        exclude: ['vue', 'a-first', 'a-first'],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toEqual([...new Set(config.optimizeDeps.include)].sort());
    expect(config.optimizeDeps.exclude).toEqual(['a-first', 'remoteApp']);
  });

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

  it('skips dev server watch ignores when watching is disabled', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      server: {
        watch: false,
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.server.watch).toBe(false);
  });

  it('preserves disabled Vite fs watching', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      server: {
        watch: null,
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.server.watch).toBeNull();
  });

  it('normalizes enabled dev server watch before adding federation ignores', () => {
    const plugin = getEarlyInitPlugin();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      server: {
        watch: true,
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(typeof config.server.watch.ignored).toBe('function');
    expect(config.server.watch.ignored('/repo/src/__mf__virtual/loadShare.js')).toBe(true);
  });

  it('skips pure virtual optimizeDeps includes in Rolldown serve', () => {
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

    expect(config.optimizeDeps.include).not.toContain(virtualRuntimeInitStatus.getImportId());
    expect(config.optimizeDeps.include).not.toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).not.toContain(getLoadShareImportId('vue', true));
    expect(config.optimizeDeps.include.join(',')).not.toContain('virtual:mf:');
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

  it('guards React DEV runtimes for Rolldown dev hosts with remotes', () => {
    const plugins = federation({
      name: 'host',
      remotes: { remote: 'remote@http://localhost:4174/remoteEntry.js' },
      shared: { react: { singleton: true } },
    }) as Plugin[];
    const earlyInitPlugin = plugins.find(
      (entry) => entry.name === 'vite:module-federation-early-init'
    );
    const federationPlugin = plugins.find(
      (entry) => entry.name === 'module-federation-vite'
    ) as Plugin & { _options: NormalizedModuleFederationOptions };
    if (!earlyInitPlugin || !federationPlugin) {
      throw new Error('module federation plugins not found');
    }

    const config: any = { root: process.cwd(), optimizeDeps: { include: [] } };
    runConfig(
      earlyInitPlugin,
      { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext,
      config,
      { command: 'serve', mode: 'test' }
    );

    const loadShareId = getLoadShareModulePath('react', true, federationPlugin._options);
    expect(VirtualModule.findById(loadShareId)?.code).toContain(
      'typeof next.getOwner !== "function"'
    );
  });

  it('decouples Rolldown react-dom/client from the react-dom optimizer entry', () => {
    const plugin = (
      federation({ name: 'host', shared: { 'react-dom': { singleton: true } } }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = { root: process.cwd(), optimizeDeps: { include: [] } };
    runConfig(plugin, { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });
    const resolver = config.optimizeDeps.rolldownOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-resolver'
    );

    expect(
      resolver.resolveId(
        'react-dom',
        '/repo/node_modules/react-dom/cjs/react-dom-client.development.js',
        { kind: 'require-call' }
      )
    ).toEqual({ id: 'module-federation:optimized-require-react-dom' });
    expect(resolver.load('module-federation:optimized-require-react-dom')).toContain(
      getLoadShareModulePath('react-dom', true)
    );
  });

  it('excludes asset imports from Rolldown optimizeDeps shared proxy', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          '@ui-lib/': {
            singleton: true,
          },
        },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = {
      root: process.cwd(),
      optimizeDeps: { include: [] },
    };

    runConfig(plugin, { meta: { rolldownVersion: '1.0.0' } } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const resolver = config.optimizeDeps.rolldownOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-resolver'
    );

    expect(
      resolver.resolveId('@ui-lib/assets/icon.svg', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(
      resolver.resolveId('@ui-lib/assets/logo.png', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(
      resolver.resolveId('@ui-lib/assets/style.css', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(
      resolver.resolveId('@ui-lib/assets/sound.mp3', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(
      resolver.resolveId(
        '@ui-lib/assets/manifest.webmanifest',
        '/repo/node_modules/.vite/deps/pkg.js'
      )
    ).toBeUndefined();
    expect(
      resolver.resolveId('@ui-lib/assets/icon.svg?url', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(
      resolver.resolveId('@ui-lib/assets/style.css?v=11111', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(
      resolver.resolveId('@ui-lib/assets/document.pdf?url', '/repo/node_modules/.vite/deps/pkg.js')
    ).toBeUndefined();
    expect(resolver.resolveId('@ui-lib/button', '/repo/node_modules/.vite/deps/pkg.js')).toEqual({
      id: expect.stringContaining(LOAD_SHARE_TAG),
      external: true,
    });
  });

  it('skips pure virtual optimizeDeps includes in non-Rolldown serve', () => {
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

    expect(config.optimizeDeps.include).not.toContain(getPreBuildLibImportId('vue'));
    expect(config.optimizeDeps.include).not.toContain(getLoadShareImportId('vue', false));
    expect(config.optimizeDeps.include.join(',')).not.toContain('virtual:mf:');
  });

  it('uses Vite-resolvable loadShare ids in non-Rolldown optimized dep shared proxies', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          'pkg-foo/': {
            singleton: true,
          },
        },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: ['pkg-bar'],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const optimizeSharedProxy = config.optimizeDeps.esbuildOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-proxy'
    );
    const onResolveHandlers: any[] = [];
    const onLoadHandlers: any[] = [];
    optimizeSharedProxy.setup({
      onResolve: (_options: unknown, handler: unknown) => onResolveHandlers.push(handler),
      onLoad: (_options: unknown, handler: unknown) => onLoadHandlers.push(handler),
    });

    const result = onLoadHandlers[0]({ path: 'pkg-foo/a' });
    const loadSharePath = getLoadShareModulePath('pkg-foo/a', false);
    const encodedLoadSharePath = toViteEncodedId(loadSharePath);

    expect(onResolveHandlers[0]({ path: encodedLoadSharePath })).toEqual({
      path: encodedLoadSharePath,
      external: true,
    });
    expect(result.contents).toContain(JSON.stringify(loadSharePath));
    expect(result.contents).not.toContain(JSON.stringify(encodedLoadSharePath));
    for (const kind of ['import-statement', 'dynamic-import']) {
      expect(
        onResolveHandlers[1]({
          path: 'pkg-foo/a',
          importer: '/repo/node_modules/pkg-b/index.js',
          kind,
        })
      ).toEqual({
        path: expect.stringContaining(LOAD_SHARE_TAG),
        external: true,
      });
    }
  });

  it('does not proxy shared deps when esbuild resolves optimizeDeps entry points', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          'entry-shared': {
            singleton: true,
          },
        },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

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

    const optimizeSharedProxy = config.optimizeDeps.esbuildOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-proxy'
    );
    const onResolveHandlers: any[] = [];
    optimizeSharedProxy.setup({
      onResolve: (_options: unknown, handler: unknown) => onResolveHandlers.push(handler),
      onLoad: () => undefined,
    });

    expect(
      onResolveHandlers[1]({
        path: 'entry-shared',
        importer: '/repo/node_modules/.vite/deps/_metadata.js',
        kind: 'entry-point',
      })
    ).toBeUndefined();
  });

  it('does not proxy a shared package self-referencing its own subpath', () => {
    const plugin = (
      federation({
        name: 'host',
        shared: { zustand: { singleton: true } },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = { root: process.cwd(), optimizeDeps: { include: [] } };
    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const optimizeSharedProxy = config.optimizeDeps.esbuildOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-proxy'
    );
    const onResolveHandlers: any[] = [];
    optimizeSharedProxy.setup({
      onResolve: (_options: unknown, handler: unknown) => onResolveHandlers.push(handler),
      onLoad: () => undefined,
    });

    expect(
      onResolveHandlers[1]({
        path: 'zustand/react',
        importer: '/repo/node_modules/zustand/esm/index.mjs',
        kind: 'import-statement',
      })
    ).toBeUndefined();
  });

  it('decouples esbuild react-dom/client from the react-dom optimizer entry', () => {
    const plugin = (
      federation({ name: 'host', shared: { 'react-dom': { singleton: true } } }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = { root: process.cwd(), optimizeDeps: { include: [] } };
    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });
    const optimizeSharedProxy = config.optimizeDeps.esbuildOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-proxy'
    );
    const onResolveHandlers: any[] = [];
    optimizeSharedProxy.setup({
      onResolve: (_options: unknown, handler: unknown) => onResolveHandlers.push(handler),
      onLoad: () => undefined,
    });

    expect(
      onResolveHandlers[1]({
        path: 'react-dom',
        importer: '/repo/node_modules/react-dom/cjs/react-dom-client.development.js',
        kind: 'require-call',
      })
    ).toEqual({ path: 'react-dom', namespace: 'mf-shared' });
  });

  it('excludes asset imports from esbuild optimizeDeps shared proxy', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          '@ui-lib/': {
            singleton: true,
          },
        },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = {
      root: process.cwd(),
      optimizeDeps: { include: [] },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const optimizeSharedProxy = config.optimizeDeps.esbuildOptions.plugins.find(
      (entry: any) => entry.name === 'module-federation:optimize-shared-proxy'
    );
    const onResolveHandlers: any[] = [];
    optimizeSharedProxy.setup({
      onResolve: (_options: unknown, handler: unknown) => onResolveHandlers.push(handler),
      onLoad: () => undefined,
    });

    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/icon.svg',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/logo.png',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/style.css',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/sound.mp3',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/manifest.webmanifest',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/icon.svg?url',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/style.css?inline',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/assets/document.pdf?url',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toBeUndefined();
    expect(
      onResolveHandlers[1]({
        path: '@ui-lib/button',
        importer: '/repo/node_modules/.vite/deps/pkg.js',
        kind: 'import-statement',
      })
    ).toEqual({
      path: expect.stringContaining(LOAD_SHARE_TAG),
      external: true,
    });
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

  it('redirects System.register proxy exports to wrapped namespaces, not helpers', () => {
    const plugin = getEsmShimsPlugin();
    const proxyFileName = `assets/host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js_commonjs-proxy-abc.js`;
    const loadShareFileName = `./host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js-def.js`;
    const consumerFileName = `assets/host${LOAD_SHARE_TAG}react_mf_2_dom_mf_1_client${LOAD_SHARE_TAG}.js-ghi.js`;
    const bundle = {
      [proxyFileName]: createChunk(
        proxyFileName,
        `System.register(["${loadShareFileName}"], (function(exports, module) {
  "use strict";
  var getAugmentedNamespace, React4;
  return {
    setters: [(module2) => {
      getAugmentedNamespace = module2.g;
      React4 = module2.R;
    }],
    execute: (function() {
      const require$$1 = exports("r", getAugmentedNamespace(React4));
    })
  };
}));`
      ),
      [consumerFileName]: createChunk(
        consumerFileName,
        `System.register(["./host${LOAD_SHARE_TAG}react${LOAD_SHARE_TAG}.js_commonjs-proxy-abc.js"], (function(exports, module) {
  "use strict";
  var require$$1;
  return {
    setters: [(module2) => {
      require$$1 = module2.r;
    }],
    execute: (function() {
      exports("r", require$$1);
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
    expect(consumer.code).toContain('require$$1 = module2.R;');
    expect(consumer.code).not.toContain('require$$1 = module2.g;');
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
    expect(resolver.resolveId('react', '/repo/src/App.cjs', { kind: 'require-call' })).toEqual({
      id: 'module-federation:optimized-require-react',
    });
    const optimizedRequireReact = resolver.load('module-federation:optimized-require-react');
    expect(optimizedRequireReact).toContain(JSON.stringify(getLoadShareModulePath('react', true)));
    expect(optimizedRequireReact).not.toContain('/@id/__x00__');
    expect(resolver.resolveId(toViteEncodedId(getLoadShareModulePath('react', true)))).toEqual({
      id: toViteEncodedId(getLoadShareModulePath('react', true)),
      external: true,
    });
    expect(resolver.resolveId('react/jsx-runtime', '/repo/src/App.tsx')).toEqual({
      id: getLoadShareModulePath('react/jsx-runtime', true),
      external: true,
    });
  });

  it('registers common shared subpath loadShare modules during early init', () => {
    const plugin = getEarlyInitPluginWithReactShared();
    const config: any = {
      root: REACT_EXAMPLE_ROOT,
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const importId = getLoadShareModulePath('react/jsx-runtime', false);
    const virtualModule = VirtualModule.findById(importId);

    expect(config.optimizeDeps.include).toContain('react/jsx-runtime');
    expect(virtualModule?.code).toContain('jsx');
  });

  it('registers only browser-safe react-dom subpaths during early init', () => {
    const plugins = federation({
      name: 'react-dom-browser-safe-host',
      filename: 'remoteEntry.js',
      shared: { 'react-dom': { singleton: true } },
    }) as Plugin[];
    const earlyInitPlugin = plugins.find(
      (entry) => entry.name === 'vite:module-federation-early-init'
    );
    const federationPlugin = plugins.find((entry) => entry.name === 'module-federation-vite') as
      | (Plugin & { _options?: NormalizedModuleFederationOptions })
      | undefined;
    if (!earlyInitPlugin || !federationPlugin?._options) {
      throw new Error('module federation plugins not found');
    }
    const config: any = {
      root: REACT_EXAMPLE_ROOT,
      optimizeDeps: { include: [], exclude: [] },
    };

    runConfig(earlyInitPlugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const optimized = [...config.optimizeDeps.include, ...config.optimizeDeps.exclude];
    const used = getUsedShares(federationPlugin._options);
    expect(optimized).toContain('react-dom/client');
    expect(optimized).toContain('react-dom/profiling');
    expect(optimized).not.toContain('react-dom/server');
    expect(optimized).not.toContain('react-dom/server.browser');
    expect(used).toContain('react-dom/client');
    expect(used).toContain('react-dom/profiling');
    expect(used).not.toContain('react-dom/server');
    expect(used).not.toContain('react-dom/server.browser');
  });

  it('does not register react/compiler-runtime when the project React version does not export it', () => {
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
      shared: {
        react: {
          singleton: true,
        },
      },
    }) as Plugin[];
    const earlyInitPlugin = plugins.find(
      (entry) => entry.name === 'vite:module-federation-early-init'
    );
    const federationPlugin = plugins.find((entry) => entry.name === 'module-federation-vite') as
      | (Plugin & { _options?: NormalizedModuleFederationOptions })
      | undefined;
    if (!earlyInitPlugin || !federationPlugin?._options) {
      throw new Error('module federation plugins not found');
    }
    const config: any = {
      root: path.join(process.cwd(), 'examples/vite-webpack-rspack/remote'),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    runConfig(earlyInitPlugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.exclude).toContain('react/compiler-runtime');
    expect(getUsedShares(federationPlugin._options)).not.toContain('react/compiler-runtime');
  });

  it('excludes a workspace-linked shared subpath resolving to raw .tsx source from dev optimizeDeps', () => {
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
      shared: {
        '@test-issue/theme/provider': {
          singleton: true,
        },
      },
    }) as Plugin[];
    const earlyInitPlugin = plugins.find(
      (entry) => entry.name === 'vite:module-federation-early-init'
    );
    if (!earlyInitPlugin) {
      throw new Error('module federation plugins not found');
    }
    const config: any = {
      root: path.join(process.cwd(), 'test-issue/host'),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    runConfig(earlyInitPlugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    // Vite's optimizer only ever bundles .js/.cjs/.mjs/.ts/.cts/.mts entries
    // (not .jsx/.tsx). Forcing a raw .tsx workspace source into `include`
    // makes Vite warn "Cannot optimize dependency" on every dev start and
    // leaves it permanently unresolved from the optimizer's perspective.
    expect(config.optimizeDeps.include).not.toContain('@test-issue/theme/provider');
    expect(config.optimizeDeps.exclude).toContain('@test-issue/theme/provider');
  });

  it('includes an ESM-only shared singleton (exports map without a "require" condition) in dev optimizeDeps', () => {
    // A package whose package.json `exports` only declares an `import` condition makes
    // Node's require.resolve throw ERR_PACKAGE_PATH_NOT_EXPORTED, even though Vite's own
    // resolver can resolve it. It must NOT be excluded from dev optimization — otherwise
    // its generated prebuild imports the raw package source and its transitive CommonJS
    // deps are served raw to the browser, which blanks the app.
    // https://github.com/module-federation/vite/issues/974
    const root = mkdtempSync(path.join(tmpdir(), 'mf-esm-only-'));
    try {
      writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'host', dependencies: { '@fixture/esm-ui': '1.0.0' } })
      );
      const pkgDir = path.join(root, 'node_modules', '@fixture', 'esm-ui');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@fixture/esm-ui',
          version: '1.0.0',
          type: 'module',
          // Only an `import` condition — no `require`/`default` — so CJS require.resolve
          // throws ERR_PACKAGE_PATH_NOT_EXPORTED while Vite can still resolve it.
          exports: { '.': { import: './index.js' } },
        })
      );
      writeFileSync(path.join(pkgDir, 'index.js'), 'export const marker = 1;\n');

      const earlyInitPlugin = (
        federation({
          name: 'host',
          filename: 'remoteEntry.js',
          shared: { '@fixture/esm-ui': { singleton: true } },
        }) as Plugin[]
      ).find((entry) => entry.name === 'vite:module-federation-early-init');
      if (!earlyInitPlugin) {
        throw new Error('vite:module-federation-early-init plugin not found');
      }

      const config: any = { root, optimizeDeps: { include: [], exclude: [] } };
      runConfig(earlyInitPlugin, {} as ConfigPluginContext, config, {
        command: 'serve',
        mode: 'test',
      });

      expect(config.optimizeDeps.include).toContain('@fixture/esm-ui');
      expect(config.optimizeDeps.exclude).not.toContain('@fixture/esm-ui');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'has no main export',
      packageName: '@fixture/no-main-export',
      exports: { './feature': { import: './feature.js' } },
      // Keep the conventional fallback on disk to prove an exports map without
      // "." is not accidentally treated as exporting index.js.
      entry: 'index.js',
    },
    {
      name: 'has a non-optimizable ESM-only main entry',
      packageName: '@fixture/esm-tsx-entry',
      exports: { '.': { import: './index.tsx' } },
      entry: 'index.tsx',
    },
  ])(
    'excludes a shared singleton that $name from dev optimizeDeps',
    ({ packageName, exports, entry }) => {
      const root = mkdtempSync(path.join(tmpdir(), 'mf-unoptimizable-esm-'));
      try {
        writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'host', dependencies: { [packageName]: '1.0.0' } })
        );
        const pkgDir = path.join(root, 'node_modules', ...packageName.split('/'));
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({
            name: packageName,
            version: '1.0.0',
            type: 'module',
            exports,
          })
        );
        writeFileSync(path.join(pkgDir, entry), 'export const marker = 1;\n');

        const earlyInitPlugin = (
          federation({
            name: 'host',
            filename: 'remoteEntry.js',
            shared: { [packageName]: { singleton: true } },
          }) as Plugin[]
        ).find((plugin) => plugin.name === 'vite:module-federation-early-init');
        if (!earlyInitPlugin) {
          throw new Error('vite:module-federation-early-init plugin not found');
        }

        const config: any = { root, optimizeDeps: { include: [], exclude: [] } };
        runConfig(earlyInitPlugin, {} as ConfigPluginContext, config, {
          command: 'serve',
          mode: 'test',
        });

        expect(config.optimizeDeps.include).not.toContain(packageName);
        expect(config.optimizeDeps.exclude).toContain(packageName);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('pre-seeds transitive shared dependencies for the dev optimizer', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          '@vite-vite/shared-lib': { singleton: true },
        },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = {
      // Use the real vite-vite host fixture so this covers pnpm's isolated
      // workspace dependency layout rather than a synthetic package graph.
      root: REACT_EXAMPLE_ROOT,
      optimizeDeps: { include: [], exclude: [], entries: ['custom-entry.ts'] },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    // The linked shared library must be part of Vite's initial optimizer
    // inputs, so its transitive imports are discovered before browser startup.
    expect(config.optimizeDeps.entries).toContain(
      path.join(REACT_EXAMPLE_ROOT, '..', 'shared-lib', 'src', 'index.tsx')
    );
    expect(config.optimizeDeps.entries).toContain('custom-entry.ts');
  });

  it('preserves optimizeDeps exclusion for linked shared source', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mf-linked-shared-'));
    try {
      const hostDir = path.join(root, 'packages', 'host');
      const sharedDir = path.join(root, 'packages', 'shared');
      const sharedSource = path.join(sharedDir, 'src', 'index.ts');
      mkdirSync(path.join(hostDir, 'node_modules', '@fixture'), { recursive: true });
      mkdirSync(path.dirname(sharedSource), { recursive: true });
      writeFileSync(path.join(hostDir, 'package.json'), JSON.stringify({ name: 'host' }));
      writeFileSync(
        path.join(sharedDir, 'package.json'),
        JSON.stringify({
          name: '@fixture/shared',
          version: '1.0.0',
          exports: {
            '.': {
              development: './src/index.ts',
              browser: './dist/index.js',
              import: './dist/index.js',
            },
          },
        })
      );
      writeFileSync(sharedSource, 'export const marker = 1;\n');
      symlinkSync(sharedDir, path.join(hostDir, 'node_modules', '@fixture', 'shared'), 'junction');

      const plugin = (
        federation({
          name: 'host',
          shared: {
            '@fixture/shared': {
              singleton: true,
              version: '1.0.0',
              import: sharedSource,
            },
          },
        }) as Plugin[]
      ).find((entry) => entry.name === 'vite:module-federation-early-init');
      if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

      const config: any = {
        root: hostDir,
        optimizeDeps: { include: [], exclude: ['@fixture/shared'] },
      };
      runConfig(plugin, {} as ConfigPluginContext, config, {
        command: 'serve',
        mode: 'test',
      });
      const normalizeHook = getNormalizeOptimizeDepsPlugin().configResolved;
      if (typeof normalizeHook !== 'function') {
        throw new Error('normalizeOptimizeDeps configResolved hook not found');
      }
      normalizeHook.call({} as MinimalPluginContextWithoutEnvironment, config);

      expect({
        included: config.optimizeDeps.include.includes('@fixture/shared'),
        excluded: config.optimizeDeps.exclude.includes('@fixture/shared'),
        sourceEntry: config.optimizeDeps.entries?.includes(sharedSource) ?? false,
      }).toEqual({ included: false, excluded: true, sourceEntry: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not create optimizer entries for missing exposes', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        exposes: { './missing': './does-not-exist.ts' },
      }) as Plugin[]
    ).find((entry) => entry.name === 'vite:module-federation-early-init');
    if (!plugin) throw new Error('vite:module-federation-early-init plugin not found');

    const config: any = { root: REACT_EXAMPLE_ROOT };
    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps?.entries).toBeUndefined();
  });

  it('registers zustand shared subpath loadShare modules during early init', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          zustand: {
            singleton: true,
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

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const vanillaImportId = getLoadShareModulePath('zustand/vanilla', false);
    const reactImportId = getLoadShareModulePath('zustand/react', false);
    const middlewareImportId = getLoadShareModulePath('zustand/middleware', false);
    const shallowImportId = getLoadShareModulePath('zustand/shallow', false);
    const optimizeDeps = [...config.optimizeDeps.include, ...config.optimizeDeps.exclude];

    expect(VirtualModule.findById(vanillaImportId)?.code).toBeTruthy();
    expect(VirtualModule.findById(reactImportId)?.code).toBeTruthy();
    expect(VirtualModule.findById(middlewareImportId)?.code).toBeTruthy();
    expect(VirtualModule.findById(shallowImportId)?.code).toBeTruthy();
    expect(optimizeDeps).toContain('zustand/vanilla');
    expect(optimizeDeps).toContain('zustand/react');
    expect(optimizeDeps).toContain('zustand/middleware');
    expect(optimizeDeps).toContain('zustand/shallow');
  });

  it('includes shared react in dev optimizeDeps when react-redux is installed', () => {
    hasPackageDependencyMock.mockImplementation(
      (dependency: string): boolean => dependency === 'react-redux'
    );
    const plugin = getEarlyInitPluginWithReactShared();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toContain('react');
    expect(config.optimizeDeps.exclude).not.toContain('react');
  });

  it('includes shared singleton react in dev optimizeDeps without react-redux', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getEarlyInitPluginWithReactShared();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
        exclude: [],
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toContain('react');
    expect(config.optimizeDeps.exclude).not.toContain('react');
  });

  it('keeps included shared react out of dev optimizeDeps exclude when react-redux is installed', () => {
    hasPackageDependencyMock.mockImplementation(
      (dependency: string): boolean => dependency === 'react-redux'
    );
    const plugin = getEarlyInitPluginWithReactShared();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: ['react'],
        exclude: [],
      },
    };

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).toContain('react');
    expect(config.optimizeDeps.exclude).not.toContain('react');
  });

  it('keeps Lit outside dev dependency optimization', () => {
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        shared: {
          lit: { singleton: true },
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

    runConfig(plugin, {} as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.exclude).toContain('lit');
    expect(config.optimizeDeps.include).not.toContain('lit');
  });

  it('removes deps from optimizeDeps exclude when another plugin includes them later', () => {
    const plugin = getNormalizeOptimizeDepsPlugin();
    const config: any = {
      optimizeDeps: {
        include: ['react'],
        exclude: ['react', 'remoteApp'],
      },
    };

    const hook = plugin.configResolved;
    if (typeof hook !== 'function') {
      throw new Error('normalizeOptimizeDeps configResolved hook not found');
    }
    hook.call({} as MinimalPluginContextWithoutEnvironment, config);

    expect(config.optimizeDeps.exclude).toEqual(['remoteApp']);
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
    expect(config.define.FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN).toBe('true');
  });

  it('maps runtime capability options to build-time defines', () => {
    const plugin = getModuleFederationVitePluginWithOptions({
      disableRemote: true,
      disableShared: true,
      disableSnapshot: true,
    });
    const config: any = {
      root: process.cwd(),
      define: {},
      resolve: { alias: [] },
      build: {},
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'build',
      mode: 'test',
    });

    expect(config.define).toMatchObject({
      FEDERATION_OPTIMIZE_NO_REMOTE: 'true',
      FEDERATION_OPTIMIZE_NO_SHARED: 'true',
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'true',
    });
  });

  it('warns once when disabled capabilities are configured for use', () => {
    const plugin = getModuleFederationVitePluginWithOptions({
      disableRemote: true,
      disableShared: true,
      remotes: {
        remoteApp: {
          name: 'remoteApp',
          entry: 'https://example.com/remoteEntry.js',
        },
      },
      shared: {
        react: {},
      },
    });
    const config: any = {
      root: process.cwd(),
      resolve: { alias: [] },
      build: {},
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'build',
      mode: 'test',
    });

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'build',
      mode: 'test',
    });

    const warningMessages = vi.mocked(mfWarn).mock.calls.map(([message]) => message);
    expect(
      warningMessages.filter((message) =>
        message.includes('disableRemote is true, but remotes are configured')
      )
    ).toHaveLength(1);
    expect(
      warningMessages.filter((message) =>
        message.includes('disableShared is true, but shared dependencies are configured')
      )
    ).toHaveLength(1);
  });

  it('allows explicitly keeping snapshots in SSR builds', () => {
    const plugin = getModuleFederationVitePluginWithOptions({
      disableSnapshot: false,
    });
    const config: any = {
      root: process.cwd(),
      define: {},
      resolve: { alias: [] },
      build: { ssr: true },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'build',
      mode: 'test',
    });

    expect(config.define.FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN).toBe('false');
  });

  it('sets ENV_TARGET node for Vite Environment API ssr builds', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getModuleFederationVitePlugin();
    const sharedDefine = { __APP__: 'true' };
    const ssrConfig: any = {
      define: sharedDefine,
      build: { ssr: true },
      consumer: 'server',
    };

    const env = { command: 'build', mode: 'test' } as ConfigEnv;
    const hook = plugin.configEnvironment;
    if (!hook) throw new Error('configEnvironment hook not found');
    if (typeof hook === 'function') {
      hook.call({} as ConfigPluginContext, 'ssr', ssrConfig, env);
    } else {
      hook.handler.call({} as ConfigPluginContext, 'ssr', ssrConfig, env);
    }

    expect(ssrConfig.define.ENV_TARGET).toBe('"node"');
    expect(ssrConfig.define.FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN).toBe('true');
    expect(sharedDefine).not.toHaveProperty('ENV_TARGET');
    expect(sharedDefine).not.toHaveProperty('FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN');
  });

  it('sets capability defines for Vite Environment API server builds', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getModuleFederationVitePluginWithOptions({
      disableRemote: true,
      disableShared: true,
      disableSnapshot: false,
    });
    const sharedDefine = { __APP__: 'true' };
    const serverConfig: any = {
      define: sharedDefine,
      build: { ssr: true },
      consumer: 'server',
    };

    const env = { command: 'build', mode: 'test' } as ConfigEnv;
    const hook = plugin.configEnvironment;
    if (!hook) throw new Error('configEnvironment hook not found');
    if (typeof hook === 'function') {
      hook.call({} as ConfigPluginContext, 'ssr', serverConfig, env);
    } else {
      hook.handler.call({} as ConfigPluginContext, 'ssr', serverConfig, env);
    }

    expect(serverConfig.define).toMatchObject({
      FEDERATION_OPTIMIZE_NO_REMOTE: 'true',
      FEDERATION_OPTIMIZE_NO_SHARED: 'true',
      FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'false',
    });
    expect(sharedDefine).toEqual({ __APP__: 'true' });
  });

  it('preserves env-level ENV_TARGET in Vite Environment API ssr builds', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getModuleFederationVitePlugin();
    const sharedDefine = { ENV_TARGET: '"web"' };
    const ssrConfig: any = {
      define: sharedDefine,
      build: { ssr: true },
      consumer: 'server',
    };

    const env = { command: 'build', mode: 'test' } as ConfigEnv;
    const hook = plugin.configEnvironment;
    if (!hook) throw new Error('configEnvironment hook not found');
    if (typeof hook === 'function') {
      hook.call({} as ConfigPluginContext, 'ssr', ssrConfig, env);
    } else {
      hook.handler.call({} as ConfigPluginContext, 'ssr', ssrConfig, env);
    }

    expect(ssrConfig.define.ENV_TARGET).toBe('"web"');
    expect(ssrConfig.define.FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN).toBe('true');
    expect(sharedDefine.ENV_TARGET).toBe('"web"');
  });

  it('preserves env-level snapshot plugin define in Vite Environment API ssr builds', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getModuleFederationVitePlugin();
    const ssrConfig: any = {
      define: { FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN: 'false' },
      build: { ssr: true },
      consumer: 'server',
    };

    const env = { command: 'build', mode: 'test' } as ConfigEnv;
    const hook = plugin.configEnvironment;
    if (!hook) throw new Error('configEnvironment hook not found');
    if (typeof hook === 'function') {
      hook.call({} as ConfigPluginContext, 'ssr', ssrConfig, env);
    } else {
      hook.handler.call({} as ConfigPluginContext, 'ssr', ssrConfig, env);
    }

    expect(ssrConfig.define.FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN).toBe('false');
  });

  it('does not mutate client ENV_TARGET in configEnvironment', () => {
    hasPackageDependencyMock.mockReturnValue(false);
    const plugin = getModuleFederationVitePlugin();
    const sharedDefine = { ENV_TARGET: '"web"' };
    const clientConfig: any = {
      define: sharedDefine,
      build: {},
      consumer: 'client',
    };

    const env = { command: 'serve', mode: 'test' } as ConfigEnv;
    const hook = plugin.configEnvironment;
    if (!hook) throw new Error('configEnvironment hook not found');
    if (typeof hook === 'function') {
      hook.call({} as ConfigPluginContext, 'client', clientConfig, env);
    } else {
      hook.handler.call({} as ConfigPluginContext, 'client', clientConfig, env);
    }

    expect(clientConfig.define).toBe(sharedDefine);
    expect(sharedDefine.ENV_TARGET).toBe('"web"');
    expect(sharedDefine).not.toHaveProperty('FEDERATION_OPTIMIZE_NO_SNAPSHOT_PLUGIN');
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
    expect(config.optimizeDeps.include.join(',')).not.toContain('virtual:mf:');
    expect(config.optimizeDeps.needsInterop).toBeUndefined();
  });

  it('resolves only the dts hints runtime plugin for optimizeDeps', () => {
    const dtsHintsPlugin = '@module-federation/dts-plugin/dynamic-remote-type-hints-plugin';
    const userPlugin = '@module-federation/runtime-core';
    const plugin = (
      federation({
        name: 'host',
        filename: 'remoteEntry.js',
        runtimePlugins: [dtsHintsPlugin, userPlugin],
      }) as Plugin[]
    ).find((entry) => entry.name === 'module-federation-vite');
    if (!plugin) throw new Error('module-federation-vite plugin not found');

    const config: any = {
      root: process.cwd(),
      optimizeDeps: { include: [] },
      resolve: { alias: [] },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    expect(config.optimizeDeps.include).not.toContain(dtsHintsPlugin);
    expect(config.optimizeDeps.include).toContain(userPlugin);
    expect(
      config.optimizeDeps.include.some(
        (dep: string) =>
          dep.includes('@module-federation/dts-plugin') &&
          dep.includes('dynamic-remote-type-hints-plugin')
      )
    ).toBe(true);
  });

  it('aliases runtime to the ESM entry for non-Rolldown optimizeDeps', () => {
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

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const runtimeAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime')
    );
    const runtimeHelpersAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime/helpers')
    );

    expect(runtimeHelpersAlias).toBeUndefined();
    expect(runtimeAlias.find).toBeInstanceOf(RegExp);
    expect((runtimeAlias.find as RegExp).test('@module-federation/runtime/helpers')).toBe(false);
    expect(runtimeAlias.replacement).toEqual(
      expect.stringMatching(/@module-federation\/runtime\/dist\/index\.js$/)
    );
    expect(config.optimizeDeps.include).toContain('@module-federation/runtime');
    expect(config.optimizeDeps.include).not.toContain('@module-federation/runtime/helpers');
  });

  it('aliases and prebundles runtime helpers for normal shared dependencies', () => {
    const plugin = getModuleFederationVitePluginWithShared();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      resolve: {
        alias: [],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const runtimeHelpersAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime/helpers')
    );

    expect(runtimeHelpersAlias.replacement).toEqual(
      expect.stringMatching(/@module-federation\/runtime\/dist\/helpers\.js$/)
    );
    expect(config.optimizeDeps.include).toContain('@module-federation/runtime/helpers');
  });

  it('aliases runtime helpers to the same runtime package for import:false provider selection', () => {
    const plugin = getModuleFederationVitePluginWithImportFalse();
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      resolve: {
        alias: [],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const runtimeAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime')
    );
    const runtimeHelpersAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime/helpers')
    );

    expect(runtimeHelpersAlias.find).toBeInstanceOf(RegExp);
    expect(
      (runtimeHelpersAlias.find as RegExp).test('@module-federation/runtime/helpers/extra')
    ).toBe(false);
    expect(runtimeHelpersAlias.replacement).toEqual(
      expect.stringMatching(/@module-federation\/runtime\/dist\/helpers\.js$/)
    );
    expect(runtimeAlias.replacement).toEqual(
      expect.stringMatching(/@module-federation\/runtime\/dist\/index\.js$/)
    );
    expect(config.optimizeDeps.include).toContain('@module-federation/runtime/helpers');
  });

  it('derives the runtime helpers alias from custom runtime implementations', () => {
    const plugin = getModuleFederationVitePluginWithImportFalse('/custom/runtime/dist/index.js');
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      resolve: {
        alias: [],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const runtimeHelpersAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime/helpers')
    );

    expect(runtimeHelpersAlias.replacement).toBe('/custom/runtime/dist/helpers.js');
  });

  it('derives the runtime helpers alias from custom runtime package paths', () => {
    const plugin = getModuleFederationVitePluginWithImportFalse('/custom/runtime');
    const config: any = {
      root: process.cwd(),
      optimizeDeps: {
        include: [],
      },
      resolve: {
        alias: [],
      },
    };

    runConfig(plugin, { meta: {} } as ConfigPluginContext, config, {
      command: 'serve',
      mode: 'test',
    });

    const runtimeHelpersAlias = config.resolve.alias.find(
      (alias: { find: string | RegExp }) =>
        alias.find instanceof RegExp && alias.find.test('@module-federation/runtime/helpers')
    );

    expect(runtimeHelpersAlias.replacement).toBe('/custom/runtime/helpers');
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
    expect(config.optimizeDeps.include).not.toContain(virtualRuntimeInitStatus.getImportId());
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

  it('handles spaces in function expression pattern', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': createChunk(
        'preload-helper-abc.js',
        'const u = function(e) { return "/" + e };modulepreload'
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

  it('handles multi-line with semicolon in function expression pattern', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': createChunk(
        'preload-helper-abc.js',
        `
        const scriptRel = "modulepreload";
        const assetsURL = function(dep) {
          return "/" + dep;
        };
        `
      ),
    };

    runGenerateBundle(
      plugin,
      {} as Rollup.PluginContext,
      {} as Rollup.NormalizedOutputOptions,
      bundle as unknown as Rollup.OutputBundle
    );

    expect((bundle['preload-helper-abc.js'] as Rollup.OutputChunk).code).toContain(
      'new URL(dep,import.meta.url).href'
    );
  });

  it('handles spaces in arrow function pattern', () => {
    const plugin = getFixPreloadPlugin();
    const bundle = {
      'preload-helper-abc.js': createChunk(
        'preload-helper-abc.js',
        'const u = e => "/" + e;modulepreload'
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

describe('experiments.externalRuntime / provideExternalRuntime', () => {
  type OptionsPlugin = Plugin & {
    _options: {
      experiments: { externalRuntime: boolean; provideExternalRuntime: boolean };
      runtimePlugins: Array<string | [string, Record<string, unknown>]>;
    };
  };

  function getOptionsPlugin(plugins: Plugin[]): OptionsPlugin {
    const plugin = plugins.find((entry) => entry.name === 'module-federation-vite') as
      | OptionsPlugin
      | undefined;
    if (!plugin) throw new Error('module-federation-vite plugin not found');
    return plugin;
  }

  it('throws when provideExternalRuntime is set on a container with exposes', () => {
    expect(() =>
      federation({
        name: 'remote',
        filename: 'remoteEntry.js',
        exposes: { './App': './src/App.tsx' },
        experiments: { provideExternalRuntime: true },
      })
    ).toThrow(
      /You can only set provideExternalRuntime: true in pure consumer which not expose modules/
    );
  });

  it('appends injectExternalRuntimeCorePlugin for pure consumers', () => {
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
      remotes: {
        remote: {
          type: 'module',
          name: 'remote',
          entry: 'http://localhost:5176/remoteEntry.js',
        },
      },
      experiments: { provideExternalRuntime: true },
    }) as Plugin[];

    const options = getOptionsPlugin(plugins)._options;
    expect(options.experiments.provideExternalRuntime).toBe(true);
    expect(
      options.runtimePlugins.some((plugin) => {
        const specifier = typeof plugin === 'string' ? plugin : plugin[0];
        return (
          specifier.includes('injectExternalRuntimeCorePlugin') ||
          specifier.includes('inject-external-runtime-core-plugin')
        );
      })
    ).toBe(true);
  });

  it('does not append the inject plugin when provideExternalRuntime is false', () => {
    const plugins = federation({
      name: 'host',
      filename: 'remoteEntry.js',
      experiments: { provideExternalRuntime: false },
    }) as Plugin[];

    const options = getOptionsPlugin(plugins)._options;
    expect(
      options.runtimePlugins.some((plugin) => {
        const specifier = typeof plugin === 'string' ? plugin : plugin[0];
        return (
          specifier.includes('injectExternalRuntimeCorePlugin') ||
          specifier.includes('inject-external-runtime-core-plugin')
        );
      })
    ).toBe(false);
  });

  it('registers the external runtime-core plugin when externalRuntime is true', () => {
    const plugins = federation({
      name: 'remote',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.tsx' },
      experiments: { externalRuntime: true },
    }) as Plugin[];

    expect(
      plugins.some((plugin) => plugin.name === 'module-federation-external-runtime-core')
    ).toBe(true);
  });

  it('does not register the external runtime-core plugin by default', () => {
    const plugins = federation({
      name: 'remote',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/App.tsx' },
    }) as Plugin[];

    expect(
      plugins.some((plugin) => plugin.name === 'module-federation-external-runtime-core')
    ).toBe(false);
  });
});
