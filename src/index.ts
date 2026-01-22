import defu from 'defu';
import { Plugin } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import { PluginDevProxyModuleTopLevelAwait } from './plugins/pluginDevProxyModuleTopLevelAwait';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import pluginDts from './plugins/pluginDts';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions,
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import VirtualModule from './utils/VirtualModule';
// wrapManualChunks not used - direct function assignment is simpler and works better
import {
  getHostAutoInitImportId,
  getHostAutoInitPath,
  getLocalSharedImportMapPath,
  initVirtualModules,
  REMOTE_ENTRY_ID,
} from './virtualModules';
import { VIRTUAL_EXPOSES } from './virtualModules/virtualExposes';

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const { name, remotes, shared, filename, hostInitInjectLocation } = options;
  if (!name) throw new Error('name is required');

  return [
    {
      name: 'vite:module-federation-config',
      enforce: 'pre',
      configResolved(config) {
        // Set root path
        VirtualModule.setRoot(config.root);
        // Ensure virtual package directory exists
        VirtualModule.ensureVirtualPackageExists();
        initVirtualModules();
      },
    },
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    normalizeOptimizeDepsPlugin,
    ...pluginDts(options),
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: REMOTE_ENTRY_ID,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: getHostAutoInitPath(),
      inject: hostInitInjectLocation,
    }),
    ...addEntry({
      entryName: 'virtualExposes',
      entryPath: VIRTUAL_EXPOSES,
    }),
    pluginProxyRemoteEntry(),
    pluginProxyRemotes(options),
    ...pluginModuleParseEnd((id: string) => {
      return (
        id.includes(getHostAutoInitImportId()) ||
        id.includes(REMOTE_ENTRY_ID) ||
        id.includes(VIRTUAL_EXPOSES) ||
        id.includes(getLocalSharedImportMapPath())
      );
    }),
    ...proxySharedModule({
      shared,
    }),
    PluginDevProxyModuleTopLevelAwait(),
    {
      name: 'module-federation-vite',
      enforce: 'post',
      // @ts-expect-error
      // used to expose plugin options: https://github.com/rolldown/rolldown/discussions/2577#discussioncomment-11137593
      _options: options,
      config(config, { command: _command }: { command: string }) {
        // TODO: singleton
        (config.resolve as any).alias.push({
          find: '@module-federation/runtime',
          replacement: options.implementation,
        });
        config.build = defu(config.build || {}, {
          commonjsOptions: {
            strictRequires: 'auto',
          },
        });
        const virtualDir = options.virtualModuleDir || '__mf__virtual';
        config.optimizeDeps?.include?.push('@module-federation/runtime');
        config.optimizeDeps?.include?.push(virtualDir);
        config.optimizeDeps?.needsInterop?.push(virtualDir);
        config.optimizeDeps?.needsInterop?.push(getLocalSharedImportMapPath());

        // FIX: Isolate preload helper to prevent deadlock with loadShare TLA
        // This prevents a circular deadlock where:
        // 1. hostInit imports preload helper from a shared chunk
        // 2. That chunk has loadShare TLA waiting for initPromise
        // 3. initPromise only resolves after remoteEntry.init() is called
        // 4. But hostInit can't call init() until the shared chunk loads → DEADLOCK
        if (_command === 'build') {
          config.build = config.build || {};
          config.build.rollupOptions = config.build.rollupOptions || {};
          config.build.rollupOptions.output = config.build.rollupOptions.output || {};

          const output = Array.isArray(config.build.rollupOptions.output)
            ? config.build.rollupOptions.output[0]
            : config.build.rollupOptions.output;

          const existingManualChunks = output.manualChunks;
          output.manualChunks = (id: string, meta: any) => {
            // Isolate preload helper to prevent deadlock
            if (
              id.includes('vite/preload-helper') ||
              id.includes('vite/modulepreload-polyfill') ||
              id.includes('commonjsHelpers')
            ) {
              return 'preload-helper';
            }
            // Call existing manualChunks if it exists
            if (typeof existingManualChunks === 'function') {
              return existingManualChunks(id, meta);
            }
            if (existingManualChunks && (existingManualChunks as any)[id]) {
              return (existingManualChunks as any)[id];
            }
            return undefined;
          };
        }
      },
    },
    ...pluginManifest(),
  ];
}

export { federation };
