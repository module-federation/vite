import { Plugin } from 'vite';
import addEntry from './plugins/pluginAddEntry';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import normalizeBuildPlugin from './utils/normalizeBuild';
import {
  ModuleFederationOptions,
  normalizeModuleFederationOptions
} from './utils/normalizeModuleFederationOptions';
import normalizeOptimizeDepsPlugin from './utils/normalizeOptimizeDeps';
import { HOST_AUTO_INIT, WRAP_REMOTE_ENTRY_PATH } from './virtualModules/virtualRemoteEntry';

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const { name, remotes, shared, filename } = options;
  if (!name) throw new Error("name is required")

  return [
    aliasToArrayPlugin,
    normalizeOptimizeDepsPlugin,
    normalizeBuildPlugin([...Object.keys(shared), "@module-federation/runtime"]),
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: WRAP_REMOTE_ENTRY_PATH,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: HOST_AUTO_INIT,
    }),
    pluginProxyRemoteEntry(),
    pluginProxyRemotes(options),
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
