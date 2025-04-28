import { join, relative } from 'pathe';
import { Plugin } from 'vite';
import {
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
} from '../utils/normalizeModuleFederationOptions';
import { getPreBuildLibImportId, getUsedRemotesMap, getUsedShares } from '../virtualModules';

type AssetMap = {
  sync: string[];
  async: string[];
};

type PreloadMap = Record<
  string,
  {
    js: AssetMap;
    css: AssetMap;
  }
>;

const Manifest = (): Plugin[] => {
  const mfOptions = getNormalizeModuleFederationOptions();
  const { name, filename, getPublicPath, manifest: manifestOptions } = mfOptions;

  let mfManifestName: string = '';
  if (manifestOptions === true) {
    mfManifestName = 'mf-manifest.json';
  }
  if (typeof manifestOptions !== 'boolean') {
    mfManifestName = join(manifestOptions?.filePath || '', manifestOptions?.fileName || '');
  }

  let extensions: string[];
  let root: string;
  let remoteEntryFile: string;
  let publicPath: string;
  let _command: string;
  let _originalConfigBase: string | undefined;
  let viteConfig: any;

  // Helper function to initialize asset maps
  const createEmptyAssetMap = (): { js: AssetMap; css: AssetMap } => ({
    js: { sync: [], async: [] },
    css: { sync: [], async: [] },
  });

  // Helper function to track assets with deduplication
  const trackAsset = (
    map: PreloadMap,
    key: string,
    fileName: string,
    isAsync: boolean,
    type: 'js' | 'css'
  ) => {
    if (!map[key]) {
      map[key] = createEmptyAssetMap();
    }
    const target = isAsync ? map[key][type].async : map[key][type].sync;
    if (!target.includes(fileName)) {
      target.push(fileName);
    }
  };

  // Helper function to check if a file is CSS
  const isCSSFile = (fileName: string): boolean => {
    return fileName.endsWith('.css') || fileName.endsWith('.scss') || fileName.endsWith('.less');
  };

  // Helper function to add CSS assets to all exports
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
      configResolved(config) {
        viteConfig = config;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!mfManifestName) {
            next();
            return;
          }
          if (req.url === (viteConfig.base + mfManifestName).replace(/^\/?/, '/')) {
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
        extensions = config.resolve.extensions || [
          '.mjs',
          '.js',
          '.mts',
          '.ts',
          '.jsx',
          '.tsx',
          '.json',
        ];
        let base = config.base;
        if (_command === 'serve') {
          base = (config.server.origin || '') + config.base;
        }
        publicPath =
          _originalConfigBase === '' ? 'auto' : base ? base.replace(/\/?$/, '/') : 'auto';
      },
      async generateBundle(options, bundle) {
        if (!mfManifestName) return;

        const filesMap: PreloadMap = {};
        const allCssAssets = new Set<string>();

        // Find remoteEntry file
        for (const [fileName, fileData] of Object.entries(bundle)) {
          if (
            mfOptions.filename.replace(/[\[\]]/g, '_').replace(/\.[^/.]+$/, '') === fileData.name ||
            fileData.name === 'remoteEntry'
          ) {
            remoteEntryFile = fileData.fileName;
          }
          // Collect all CSS assets
          if (fileData.type === 'asset' && isCSSFile(fileName)) {
            allCssAssets.add(fileName);
          }
        }

        const exposesModules = Object.keys(mfOptions.exposes).map(
          (item) => mfOptions.exposes[item].import
        );

        // Process modules and their associated assets
        for (const [fileName, fileData] of Object.entries(bundle)) {
          if (fileData.type === 'chunk') {
            for (const modulePath of Object.keys(fileData.modules)) {
              const relativeModulePath = relative(root, modulePath);

              // Handle exposed modules
              for (const exposeModule of exposesModules) {
                const formatExposeModule = exposeModule.replace('./', '');
                if (
                  relativeModulePath === formatExposeModule ||
                  extensions.some((ext) => relativeModulePath === `${formatExposeModule}${ext}`)
                ) {
                  // Track the JS chunk
                  trackAsset(filesMap, exposeModule, fileName, false, 'js');

                  // Handle dynamic imports
                  if (fileData.dynamicImports) {
                    for (const dynamicImport of fileData.dynamicImports) {
                      const importData = bundle[dynamicImport];
                      if (importData) {
                        if (importData.type === 'asset' && isCSSFile(dynamicImport)) {
                          trackAsset(filesMap, exposeModule, dynamicImport, true, 'css');
                        } else {
                          trackAsset(filesMap, exposeModule, dynamicImport, true, 'js');
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Process shared modules
        const fileToShareKey: Record<string, string> = {};
        await Promise.all(
          Array.from(getUsedShares()).map(async (shareKey) => {
            const file = (await (this as any).resolve(getPreBuildLibImportId(shareKey))).id.split(
              '?'
            )[0];
            fileToShareKey[file] = shareKey;
          })
        );

        for (const [fileName, fileData] of Object.entries(bundle)) {
          if (fileData.type === 'chunk') {
            for (const modulePath of Object.keys(fileData.modules)) {
              const sharedKey = fileToShareKey[modulePath];
              if (sharedKey) {
                // Track the JS chunk
                trackAsset(filesMap, sharedKey, fileName, false, 'js');

                // Handle dynamic imports
                if (fileData.dynamicImports) {
                  for (const dynamicImport of fileData.dynamicImports) {
                    const importData = bundle[dynamicImport];
                    if (importData) {
                      if (importData.type === 'asset' && isCSSFile(dynamicImport)) {
                        trackAsset(filesMap, sharedKey, dynamicImport, true, 'css');
                      } else {
                        trackAsset(filesMap, sharedKey, dynamicImport, true, 'js');
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Add all CSS assets to every export
        addCssAssetsToAllExports(filesMap, allCssAssets);

        // Final deduplication of all arrays in the filesMap
        Object.values(filesMap).forEach((assetMaps) => {
          ['js', 'css'].forEach((type) => {
            ['sync', 'async'].forEach((timing) => {
              assetMaps[type as 'js' | 'css'][timing as 'sync' | 'async'] = Array.from(
                new Set(assetMaps[type as 'js' | 'css'][timing as 'sync' | 'async'])
              );
            });
          });
        });

        this.emitFile({
          type: 'asset',
          fileName: mfManifestName,
          source: JSON.stringify(generateMFManifest(filesMap)),
        });
      },
    },
  ];

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
