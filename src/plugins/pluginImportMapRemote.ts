import * as path from 'node:path';
import type { Plugin, UserConfig } from 'vite';
import {
  exposeEntryName,
  IMPORT_MAP_MANIFEST_FILE,
  type ImportMapManifest,
  sharedKeyOwning,
} from '../utils/importMapSpecifiers';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';

/**
 * Remote side of import-map mode. A remote ships only its own code:
 *
 * - one fixed-name entry per expose (`./Button` → `Button.js`), signature-preserving,
 *   so the host can map `<remote>/Button` to a stable URL;
 * - every shared key (and every configured remote) stays an external bare import,
 *   resolved at runtime by the host's import map;
 * - `importmap-manifest.json` lists the expose → file mapping for the host.
 */
export function pluginImportMapRemote(options: NormalizedModuleFederationOptions): Plugin {
  const sharedKeys = Object.keys(options.shared);
  const remoteKeys = Object.keys(options.remotes);
  const isExternal = (id: string) =>
    sharedKeys.includes(id) || remoteKeys.some((key) => id === key || id.startsWith(`${key}/`));
  const unsharedSubpaths = new Map<string, string>();
  let publicPath = options.publicPath ?? '/';

  return {
    name: 'module-federation:importmap-remote',
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
              format: 'es',
              entryFileNames: '[name].js',
              chunkFileNames: 'assets/[name]-[hash].js',
            },
          },
        },
      };
    },
    configResolved(config) {
      publicPath = options.publicPath ?? config.base;
    },
    buildStart() {
      unsharedSubpaths.clear();
    },
    resolveId(id, importer) {
      // A subpath of a shared package that is not itself shared would be bundled into
      // the remote, giving it a private copy of that package's internals.
      if (!isExternal(id) && sharedKeyOwning(id, sharedKeys) && importer) {
        unsharedSubpaths.set(id, importer);
      }
      return null;
    },
    buildEnd() {
      for (const [id, importer] of unsharedSubpaths) {
        this.warn(
          `"${id}" (imported by ${importer}) is a subpath of a shared package but is not ` +
            'shared itself, so it is bundled into this remote. Add it to `shared`.'
        );
      }
    },
    generateBundle(_outputOptions, bundle) {
      const exposes: Record<string, string> = {};
      for (const key of Object.keys(options.exposes)) {
        const entryName = exposeEntryName(key);
        const chunk = Object.values(bundle).find(
          (item) => item.type === 'chunk' && item.isEntry && item.name === entryName
        );
        if (chunk) exposes[key] = chunk.fileName;
      }
      const manifest: ImportMapManifest = {
        name: options.name,
        mode: 'importmap',
        publicPath,
        exposes,
      };
      this.emitFile({
        type: 'asset',
        fileName: IMPORT_MAP_MANIFEST_FILE,
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}
