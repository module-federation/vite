import type { Plugin } from 'vite';
import { version as viteVersion } from 'vite';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { resolveRemoteConsumer } from '../utils/remoteConsumerTarget';
import { getSsrCapabilities } from '../utils/ssrCapabilities';
import { getInstalledPackageEntry } from '../utils/packageUtils';
import { filterId } from '../utils/pathNormalization';
import { addUsedRemote, getRemoteVirtualModule, refreshHostAutoInit } from '../virtualModules';

function isNodeModulesImporter(importer?: string) {
  return importer?.includes('/node_modules/') || importer?.includes('\\node_modules\\');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  let enableSsrInit = false;
  let hasMultiEnvironment = false;
  const { remotes } = options;

  function resolveRemoteId(
    pluginContext: unknown,
    source: string,
    importer: string | undefined,
    remoteName: string
  ) {
    if (source === remoteName) {
      const installedPackageEntry = getInstalledPackageEntry(source, { cwd: root });
      if (installedPackageEntry && (importer === undefined || isNodeModulesImporter(importer))) {
        return installedPackageEntry;
      }
    }
    const consumer = resolveRemoteConsumer(pluginContext, hasMultiEnvironment);
    const remoteModule = getRemoteVirtualModule(source, command, enableSsrInit, consumer);
    addUsedRemote(remoteName, source);
    refreshHostAutoInit();
    return remoteModule.getImportId();
  }

  return {
    name: 'proxyRemotes',
    enforce: 'pre',
    applyToEnvironment() {
      return true;
    },
    config(config, { command: _command }) {
      command = _command;
      root = config.root || process.cwd();
      Object.keys(remotes).forEach((remoteAlias) => {
        appendAlias(config as Record<string, any>, {
          find: new RegExp(`^(${escapeRegExp(remoteAlias)}(\/.*|$))`),
          replacement: '$1',
        });
      });
    },
    configResolved(config) {
      hasMultiEnvironment = Boolean(
        (config as { environments?: Record<string, unknown> }).environments?.ssr
      );
      enableSsrInit = getSsrCapabilities(
        parseInt(viteVersion, 10),
        command as 'serve' | 'build',
        Object.keys(remotes).length > 0
      ).enableSsrInitBootstrap;
    },
    resolveId(source, importer) {
      if (!filterId(source)) return;
      for (const remoteAlias of Object.keys(remotes)) {
        if (source !== remoteAlias && !source.startsWith(`${remoteAlias}/`)) continue;
        return resolveRemoteId(this, source, importer, remoteAlias);
      }
    },
  };
}
