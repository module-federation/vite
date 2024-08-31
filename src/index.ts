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
import { HOST_AUTO_INIT_PATH, HOST_AUTO_INIT_QUERY_STR, REMOTE_ENTRY_ID, WRAP_REMOTE_ENTRY_PATH, WRAP_REMOTE_ENTRY_QUERY_STR } from './virtualModules/virtualRemoteEntry';
import { getLocalSharedImportMapPath } from './virtualModules/virtualShared_preBuild';

function federation(mfUserOptions: ModuleFederationOptions): Plugin[] {
  const options = normalizeModuleFederationOptions(mfUserOptions);
  const { name, remotes, shared, filename } = options;
  if (!name) throw new Error("name is required")

  return [
    aliasToArrayPlugin,
    normalizeOptimizeDepsPlugin,
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: WRAP_REMOTE_ENTRY_PATH,
      fileName: filename,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: HOST_AUTO_INIT_PATH,
    }),
    pluginProxyRemoteEntry(),
    pluginProxyRemotes(options),
    ...pluginModuleParseEnd(((id: string) => {
      return id.includes(HOST_AUTO_INIT_QUERY_STR) || id.includes(WRAP_REMOTE_ENTRY_QUERY_STR) || id.includes(REMOTE_ENTRY_ID) || id.includes(getLocalSharedImportMapPath())
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
