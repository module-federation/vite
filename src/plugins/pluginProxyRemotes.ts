import { createFilter } from '@rollup/pluginutils';
import type { Plugin } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getInstalledPackageEntry } from '../utils/packageUtils';
import { addUsedRemote, getRemoteVirtualModule, refreshHostAutoInit } from '../virtualModules';
const filter: (id: string) => boolean = createFilter();

function isNodeModulesImporter(importer?: string) {
  return importer?.includes('/node_modules/') || importer?.includes('\\node_modules\\');
}

export default function (options: NormalizedModuleFederationOptions): Plugin {
  let command: string;
  let root = process.cwd();
  const { remotes } = options;

  function resolveRemoteId(source: string, importer: string | undefined, remoteName: string) {
    if (source === remoteName) {
      const installedPackageEntry = getInstalledPackageEntry(source, { cwd: root });
      if (installedPackageEntry && (importer === undefined || isNodeModulesImporter(importer))) {
        return installedPackageEntry;
      }
    }
    const remoteModule = getRemoteVirtualModule(source, command);
    addUsedRemote(remoteName, source);
    refreshHostAutoInit();
    return remoteModule.getPath();
  }

  return {
    name: 'proxyRemotes',
    config(config, { command: _command }) {
      command = _command;
      root = config.root || process.cwd();
      Object.keys(remotes).forEach((key) => {
        const remote = remotes[key];
        (config.resolve as any).alias.push({
          find: new RegExp(`^(${remote.name}(\/.*|$))`),
          replacement: '$1',
        });
      });
    },
    resolveId(source, importer) {
      if (!filter(source)) return;
      for (const remote of Object.values(remotes)) {
        if (source !== remote.name && !source.startsWith(`${remote.name}/`)) continue;
        return resolveRemoteId(source, importer, remote.name);
      }
    },
  };
}
