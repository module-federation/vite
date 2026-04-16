import { createFilter } from '@rollup/pluginutils';
import { Plugin } from 'vite';
import { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getInstalledPackageEntry, getIsRolldown } from '../utils/packageUtils';
import { addUsedRemote, getRemoteVirtualModule } from '../virtualModules';
const filter: (id: string) => boolean = createFilter();

function isNodeModulesImporter(importer?: string) {
  return importer?.includes('/node_modules/') || importer?.includes('\\node_modules\\');
}

export default function (options: NormalizedModuleFederationOptions): Plugin {
  let command: string;
  let root = process.cwd();
  const { remotes } = options;

  function resolveRemoteId(
    source: string,
    importer: string | undefined,
    remoteName: string,
    isRolldown: boolean
  ) {
    if (source === remoteName) {
      const installedPackageEntry = getInstalledPackageEntry(source, { cwd: root });
      if (installedPackageEntry && (importer === undefined || isNodeModulesImporter(importer))) {
        return installedPackageEntry;
      }
    }
    const remoteModule = getRemoteVirtualModule(source, command, isRolldown);
    addUsedRemote(remoteName, source);
    return remoteModule.getPath();
  }

  return {
    name: 'proxyRemotes',
    config(config, { command: _command }) {
      command = _command;
      root = config.root || process.cwd();
      const isRolldown = getIsRolldown(this);
      Object.keys(remotes).forEach((key) => {
        const remote = remotes[key];
        (config.resolve as any).alias.push({
          find: new RegExp(`^(${remote.name}(\/.*|$))`),
          replacement: '$1',
          customResolver(source: string, importer?: string) {
            return resolveRemoteId(source, importer, remote.name, isRolldown);
          },
        });
      });
    },
    resolveId(source, importer) {
      if (!filter(source)) return;
      const isRolldown = getIsRolldown(this);
      for (const remote of Object.values(remotes)) {
        if (source !== remote.name) continue;
        return resolveRemoteId(source, importer, remote.name, isRolldown);
      }
    },
  };
}
