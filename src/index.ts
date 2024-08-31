import { Plugin } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import pluginModuleParseEnd from './plugins/pluginModuleParseEnd';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import { getHostAutoInitImportId, getHostAutoInitPath, getLocalSharedImportMapPath, getWrapRemoteEntryImportId, getWrapRemoteEntryPath, initVirtualModules, REMOTE_ENTRY_ID } from './virtualModules';

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  initVirtualModules()
  const { name, remotes, shared, filename } = options;
  if (!name) throw new Error("name is required")

  return [
    aliasToArrayPlugin,
    normalizeOptimizeDepsPlugin,
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: getWrapRemoteEntryPath(),
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: getHostAutoInitPath(),
    }),
    pluginProxyRemoteEntry(),
    pluginProxyRemotes(options),
    ...pluginModuleParseEnd(((id: string) => {
      return id.includes(getHostAutoInitImportId()) || id.includes(getWrapRemoteEntryImportId()) || id.includes(REMOTE_ENTRY_ID) || id.includes(getLocalSharedImportMapPath())
    })),
    ...proxySharedModule({
      shared,
    }),
    {
      name: 'module-federation-vite',
      enforce: 'post',
      config(config, { command: _command }: { command: string }) {
        ; (config.resolve as any).alias.push({
          find: '@module-federation/runtime',
          replacement: require.resolve('@module-federation/runtime'),
        },)

        config.optimizeDeps?.include?.push('@module-federation/runtime');
        // Object.keys(shared).forEach((key) => {
        //   config.optimizeDeps?.include?.push(key);
        // });
      },
    },
  ];
}

export { federation };
