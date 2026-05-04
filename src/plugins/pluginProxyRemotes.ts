import type { Plugin } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getInstalledPackageEntry } from '../utils/packageUtils';
import { filterId } from '../utils/pathNormalization';
import { addUsedRemote, getRemoteVirtualModule, refreshHostAutoInit } from '../virtualModules';

function isNodeModulesImporter(importer?: string) {
  return importer?.includes('/node_modules/') || importer?.includes('\\node_modules\\');
}

function appendAlias(config: Record<string, any>, alias: { find: RegExp; replacement: string }) {
  config.resolve ??= {};
  const existingAlias = config.resolve.alias;
  if (!existingAlias) {
    config.resolve.alias = [alias];
    return;
  }
  if (Array.isArray(existingAlias)) {
    existingAlias.push(alias);
    return;
  }
  config.resolve.alias = [
    ...Object.entries(existingAlias).map(([find, replacement]) => ({ find, replacement })),
    alias,
  ];
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
    enforce: 'pre',
    config(config, { command: _command }) {
      command = _command;
      root = config.root || process.cwd();
      Object.keys(remotes).forEach((key) => {
        const remote = remotes[key];
        appendAlias(config as Record<string, any>, {
          find: new RegExp(`^(${remote.name}(\/.*|$))`),
          replacement: '$1',
        });
      });
    },
    resolveId(source, importer) {
      if (!filterId(source)) return;
      for (const remote of Object.values(remotes)) {
        if (source !== remote.name && !source.startsWith(`${remote.name}/`)) continue;
        return resolveRemoteId(source, importer, remote.name);
      }
    },
  };
}
