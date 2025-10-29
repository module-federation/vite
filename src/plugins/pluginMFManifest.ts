import * as path from 'pathe';
import { Plugin } from 'vite';
import type { PluginContext } from 'rollup';
import {
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
} from '../utils/normalizeModuleFederationOptions';
import { getUsedRemotesMap, getUsedShares } from '../virtualModules';

import {
  buildFileToShareKeyMap,
  collectCssAssets,
  createEmptyAssetMap,
  deduplicateAssets,
  JS_EXTENSIONS,
  PreloadMap,
  processModuleAssets,
  trackAsset,
} from '../utils/cssModuleHelpers';
import { resolvePublicPath } from '../utils/publicPath';

// Helper to build share key map with proper context typing
interface BuildFileToShareKeyMapContext {
  resolve: PluginContext['resolve'];
}

const Manifest = (): Plugin[] => {
  const mfOptions = getNormalizeModuleFederationOptions();
  const { name, filename, getPublicPath, manifest: manifestOptions } = mfOptions;

  let mfManifestName: string = '';
  let disableMainfestCssInject: boolean | undefined;
  if (manifestOptions === true) {
    mfManifestName = 'mf-manifest.json';
  }
  if (typeof manifestOptions !== 'boolean') {
    mfManifestName = path.join(manifestOptions?.filePath || '', manifestOptions?.fileName || '');
    disableMainfestCssInject = manifestOptions.disableAssetsAnalyze;
  }

  let root: string;
  let remoteEntryFile: string;
  let publicPath: string;
  let _command: string;
  let _originalConfigBase: string | undefined;
  let viteConfig: any;

  /**
   * Adds global CSS assets to all module exports
   * @param filesMap - The preload map to update
   * @param cssAssets - Set of CSS asset filenames to add
   */
  const addCssAssetsToAllExports = (filesMap: PreloadMap, cssAssets: Set<string>) => {
    Object.keys(filesMap).forEach((key) => {
      cssAssets.forEach((cssAsset) => {
        trackAsset(filesMap, key, cssAsset, false, 'css');
      });
    });
  };

  return [
    {
      name: 'module-federation-manifest',
      apply: 'serve',
      /**
       * Stores resolved Vite config for later use
       */
      /**
       * Finalizes configuration after all plugins are resolved
       * @param config - Fully resolved Vite config
       */
      configResolved(config) {
        viteConfig = config;
      },
      /**
       * Configures dev server middleware to handle manifest requests
       * @param server - Vite dev server instance
       */
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!mfManifestName) {
            next();
            return;
          }
          if (
            req.url?.replace(/\?.*/, '') === (viteConfig.base + mfManifestName).replace(/^\/?/, '/')
          ) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.end(
              JSON.stringify({
                ...generateMFManifest({}),
                id: name,
                name: name,
                metaData: {
                  name: name,
                  type: 'app',
                  buildInfo: { buildVersion: '1.0.0', buildName: name },
                  remoteEntry: {
                    name: filename,
                    path: '',
                    type: 'module',
                  },
                  ssrRemoteEntry: {
                    name: filename,
                    path: '',
                    type: 'module',
                  },
                  types: { path: '', name: '' },
                  globalName: name,
                  pluginVersion: '0.2.5',
                  publicPath,
                },
              })
            );
          } else {
            next();
          }
        });
      },
    },
    {
      name: 'module-federation-manifest',
      enforce: 'post',
      /**
       * Initial plugin configuration
       * @param config - Vite config object
       * @param command - Current Vite command (serve/build)
       */
      config(config, { command }) {
        if (!config.build) config.build = {};
        if (!config.build.manifest) {
          config.build.manifest = config.build.manifest || !!manifestOptions;
        }
        _command = command;
        _originalConfigBase = config.base;
      },
      configResolved(config) {
        root = config.root;
        let base = config.base;
        if (_command === 'serve') {
          base = (config.server.origin || '') + config.base;
        }
        publicPath = resolvePublicPath(mfOptions, base, _originalConfigBase);
      },
      /**
       * Generates the module federation manifest file
       * @param options - Rollup output options
       * @param bundle - Generated bundle assets
       */
      async generateBundle(options, bundle) {
        if (!mfManifestName) return;

        let filesMap: PreloadMap = {};

        // First pass: Find remoteEntry file
        for (const [_, fileData] of Object.entries(bundle)) {
          if (
            mfOptions.filename.replace(/[\[\]]/g, '_').replace(/\.[^/.]+$/, '') === fileData.name ||
            fileData.name === 'remoteEntry'
          ) {
            remoteEntryFile = fileData.fileName;
            break; // We can break early since we only need to find remoteEntry once
          }
        }

        // Second pass: Collect all CSS assets
        const allCssAssets = disableMainfestCssInject
          ? new Set<string>()
          : collectCssAssets(bundle);

        const exposesModules = Object.keys(mfOptions.exposes).map(
          (item) => mfOptions.exposes[item].import
        );

        // Process exposed modules
        processModuleAssets(bundle, filesMap, (modulePath) => {
          const absoluteModulePath = path.resolve(root, modulePath);
          return exposesModules.find((exposeModule) => {
            const exposePath = path.resolve(root, exposeModule);

            // First try exact path match
            if (absoluteModulePath === exposePath) {
              return true;
            }

            // Then try path match without known extensions
            const getPathWithoutKnownExt = (filePath: string) => {
              const ext = path.extname(filePath);
              return JS_EXTENSIONS.includes(ext as any)
                ? path.join(path.dirname(filePath), path.basename(filePath, ext))
                : filePath;
            };
            const modulePathNoExt = getPathWithoutKnownExt(absoluteModulePath);
            const exposePathNoExt = getPathWithoutKnownExt(exposePath);
            return modulePathNoExt === exposePathNoExt;
          });
        });

        // Process shared modules
        const fileToShareKey = await buildFileToShareKeyMap(
          getUsedShares(),
          this.resolve.bind(this)
        );
        processModuleAssets(bundle, filesMap, (modulePath) => fileToShareKey.get(modulePath));

        // Add all CSS assets to every export
        !disableMainfestCssInject && addCssAssetsToAllExports(filesMap, allCssAssets);

        // Final deduplication of all assets
        filesMap = deduplicateAssets(filesMap);

        this.emitFile({
          type: 'asset',
          fileName: mfManifestName,
          source: JSON.stringify(generateMFManifest(filesMap)),
        });
      },
    },
  ];

  /**
   * Generates the final manifest JSON structure
   * @param preloadMap - Map of module assets to include
   * @returns Complete manifest object
   */
  function generateMFManifest(preloadMap: PreloadMap) {
    const options = getNormalizeModuleFederationOptions();
    const { name } = options;
    const remoteEntry = {
      name: remoteEntryFile,
      path: '',
      type: 'module',
    };

    // Process remotes
    const remotes = Array.from(Object.entries(getUsedRemotesMap())).flatMap(
      ([remoteKey, modules]) =>
        Array.from(modules).map((moduleKey) => ({
          federationContainerName: options.remotes[remoteKey].entry,
          moduleName: moduleKey.replace(remoteKey, '').replace('/', ''),
          alias: remoteKey,
          entry: '*',
        }))
    );

    // Process shared dependencies
    const shared = Array.from(getUsedShares())
      .map((shareKey) => {
        const shareItem = getNormalizeShareItem(shareKey);
        const assets = preloadMap[shareKey] || createEmptyAssetMap();

        return {
          id: `${name}:${shareKey}`,
          name: shareKey,
          version: shareItem.version,
          requiredVersion: shareItem.shareConfig.requiredVersion,
          assets: {
            js: {
              async: assets.js.async,
              sync: assets.js.sync,
            },
            css: {
              async: assets.css.async,
              sync: assets.css.sync,
            },
          },
        };
      })
      .filter(Boolean);

    // Process exposed modules
    const exposes = Object.entries(options.exposes)
      .map(([key, value]) => {
        const formatKey = key.replace('./', '');
        const sourceFile = value.import;
        const assets = preloadMap[sourceFile] || createEmptyAssetMap();

        return {
          id: `${name}:${formatKey}`,
          name: formatKey,
          assets: {
            js: {
              async: assets.js.async,
              sync: assets.js.sync,
            },
            css: {
              async: assets.css.async,
              sync: assets.css.sync,
            },
          },
          path: key,
        };
      })
      .filter(Boolean);

    return {
      id: name,
      name,
      metaData: {
        name,
        type: 'app',
        buildInfo: {
          buildVersion: '1.0.0',
          buildName: name,
        },
        remoteEntry,
        ssrRemoteEntry: remoteEntry,
        types: {
          path: '',
          name: '',
        },
        globalName: name,
        pluginVersion: '0.2.5',
        ...(!!getPublicPath ? { getPublicPath } : { publicPath }),
      },
      shared,
      remotes,
      exposes,
    };
  }
};

export default Manifest;
