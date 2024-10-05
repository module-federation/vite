import { Plugin } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import { PluginDevProxyModuleTopLevelAwait } from './plugins/pluginDevProxyModuleTopLevelAwait';
import pluginManifest from './plugins/pluginMFManifest';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions,
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
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
  initVirtualModules();
  const { name, remotes, shared, filename } = options;
  if (!name) throw new Error('name is required');

  return [
    aliasToArrayPlugin,
    normalizeOptimizeDepsPlugin,
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: REMOTE_ENTRY_ID,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: getHostAutoInitPath(),
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
      config(config, { command: _command }: { command: string }) {
        // TODO: singleton
        (config.resolve as any).alias.push({
          find: '@module-federation/runtime',
          replacement: require.resolve('@module-federation/runtime'),
        });

        config.optimizeDeps?.include?.push('@module-federation/runtime');
        config.optimizeDeps?.include?.push('__mf__virtual');
        config.optimizeDeps?.needsInterop?.push('__mf__virtual');
        config.optimizeDeps?.needsInterop?.push(getLocalSharedImportMapPath());
      },
    },
    ...pluginManifest(),
  ];
}

export { federation };
