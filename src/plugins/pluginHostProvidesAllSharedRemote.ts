import * as path from 'node:path';
import type { Plugin, UserConfig } from 'vite';
import packageJson from '../../package.json' with { type: 'json' };
import {
  exposeEntryName,
  type HostProvidesAllSharedManifest,
  isRemoteSpecifier,
  sharedKeyOwning,
} from '../utils/hostProvidesAllShared';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getBuildVersion, resolveTypesMeta } from './pluginMFManifest';

/**
 * Remote side of `experiments.hostProvidesAllShared`. The remote ships only its own code:
 *
 * - one fixed-name, signature-preserving entry per expose (`./Button` → `Button.js`), so
 *   the host can map `<remote>/Button` to a stable URL;
 * - every shared key, and every configured remote, stays an external bare import that the
 *   host's import map resolves at runtime;
 * - a standard `mf-manifest.json` without `remoteEntry`, listing each expose's entry file.
 */
export function pluginHostProvidesAllSharedRemote(
  options: NormalizedModuleFederationOptions
): Plugin {
  const sharedKeys = Object.keys(options.shared);
  const remoteKeys = Object.keys(options.remotes);
  const isExternal = (id: string) => sharedKeys.includes(id) || isRemoteSpecifier(id, remoteKeys);
  const unsharedSubpaths = new Map<string, string>();
  let publicPath = '/';

  return {
    name: 'module-federation:host-provides-all-shared-remote',
    enforce: 'pre',
    apply: 'build',
    config(config: UserConfig) {
      const root = path.resolve(config.root ?? process.cwd());
      const input = Object.fromEntries(
        Object.entries(options.exposes).map(([key, expose]) => [
          exposeEntryName(key),
          path.resolve(root, expose.import),
        ])
      );
      return {
        build: {
          rollupOptions: {
            input,
            external: isExternal,
            preserveEntrySignatures: 'strict',
            output: {
              entryFileNames: '[name].js',
              chunkFileNames: 'assets/[name]-[hash].js',
            },
          },
        },
      };
    },
    configResolved(config) {
      // `auto` is a valid manifest value: the host infers it from the manifest URL.
      publicPath = options.publicPath ?? config.base;
    },
    buildStart() {
      unsharedSubpaths.clear();
    },
    resolveId(id, importer) {
      if (importer && !isExternal(id) && sharedKeyOwning(id, sharedKeys)) {
        unsharedSubpaths.set(id, importer);
      }
      return null;
    },
    buildEnd() {
      for (const [id, importer] of unsharedSubpaths) {
        this.warn(
          `"${id}" (imported by ${importer}) is a subpath of a shared package but is not ` +
            'shared itself, so a private copy is bundled into this remote. Add it to `shared`.'
        );
      }
    },
    generateBundle(_outputOptions, bundle) {
      const { name } = options;
      const exposes: HostProvidesAllSharedManifest['exposes'] = [];
      for (const key of Object.keys(options.exposes)) {
        const entryName = exposeEntryName(key);
        const chunk = Object.values(bundle).find(
          (item) => item.type === 'chunk' && item.isEntry && item.name === entryName
        );
        if (!chunk) continue;
        exposes.push({
          id: `${name}:${entryName}`,
          name: entryName,
          path: key,
          assets: {
            js: { sync: [chunk.fileName], async: [] },
            css: { sync: [], async: [] },
          },
        });
      }
      const manifest: HostProvidesAllSharedManifest = {
        id: name,
        name,
        metaData: {
          name,
          type: 'app',
          buildInfo: { buildVersion: getBuildVersion(), buildName: name },
          globalName: name,
          pluginVersion: packageJson.version,
          publicPath,
          types: resolveTypesMeta(options.dts),
        },
        shared: [],
        remotes: [],
        exposes,
      };
      this.emitFile({
        type: 'asset',
        fileName:
          (typeof options.manifest === 'object' && options.manifest.fileName) || 'mf-manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}
