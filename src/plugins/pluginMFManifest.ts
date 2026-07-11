import * as path from 'node:path';
import { Plugin } from 'vite';
import {
  getNormalizeModuleFederationOptions,
  getNormalizeShareItem,
  type RemoteObjectConfig,
} from '../utils/normalizeModuleFederationOptions';
import { getUsedRemotesMap, getUsedShares } from '../virtualModules';

import { findRemoteEntryFile } from '../utils/bundleHelpers';
import {
  addCssAssetsToAllExports,
  buildFileToShareKeyMap,
  collectCssAssets,
  createEmptyAssetMap,
  deduplicateAssets,
  type PreloadMap,
  processModuleAssets,
} from '../utils/cssModuleHelpers';
import { resolvePublicPath } from '../utils/pathNormalization';
import { getSsrRemoteEntryFileName } from '../virtualModules/virtualRemoteEntrySSR';
import { DEFAULT_PUBLIC_TYPES_FOLDER } from './pluginDts';

/**
 * Resolves the build version for the module federation manifest.
 *
 * Priority:
 * 1. `MF_BUILD_VERSION` environment variable (set by CI or manually)
 * 2. Falls back to `'1.0.0'` to preserve backward compatibility
 *
 * This mirrors the behavior of the webpack/rspack plugins via
 * `getBuildVersion()` from `@module-federation/managers`.
 */
function getBuildVersion(): string {
  return process.env['MF_BUILD_VERSION'] ?? '1.0.0';
}

/**
 * Builds the manifest `metaData.types` entry.
 *
 * When type generation is enabled, the dts plugin serves the type archive
 * (`<typesFolder>.zip`) and api file (`<typesFolder>.d.ts`). Consumers using
 * `@module-federation/dts-plugin` read `metaData.types.zip` to download those
 * types and throw `Can not get <remote>'s types archive url!` when it is absent.
 * Advertising the relative paths here (resolved against `publicPath` by the
 * consumer) mirrors the webpack/rspack (`@module-federation/enhanced`) plugins.
 */
function resolveTypesMeta(dts: ReturnType<typeof getNormalizeModuleFederationOptions>['dts']): {
  path: string;
  name: string;
  zip?: string;
  api?: string;
} {
  if (dts === false) return { path: '', name: '' };
  const generateTypes = typeof dts === 'object' && dts ? dts.generateTypes : undefined;
  if (generateTypes === false) return { path: '', name: '' };
  const typesFolder =
    (typeof generateTypes === 'object' && generateTypes?.typesFolder) ||
    DEFAULT_PUBLIC_TYPES_FOLDER;
  return {
    path: '',
    name: '',
    zip: `${typesFolder}.zip`,
    api: `${typesFolder}.d.ts`,
  };
}

function resolveDevRemoteEntryFileName(fileName: string): string {
  if (!fileName.includes('[hash')) return fileName;

  const normalized = fileName.replace(/(?:[._-]?\[hash(?::\d+)?\])/g, '');
  const baseName = path.basename(normalized);

  return path.extname(baseName) ? normalized : `${normalized}.js`;
}

function createRemoteEntryAssetMap(fileName: string) {
  return {
    js: { async: [], sync: [fileName] },
    css: { async: [], sync: [] },
  };
}

function getRemoteContainerName(remoteKey: string, remote: RemoteObjectConfig) {
  // Object-form remotes default entryGlobalName to the alias during
  // normalization, while string-form remotes use it for `Name@entry`.
  const entryGlobalName = remote.entryGlobalName;
  if (entryGlobalName && entryGlobalName !== remoteKey && entryGlobalName !== remote.entry) {
    return entryGlobalName;
  }
  return remote.name;
}

const Manifest = (): Plugin[] => {
  const mfOptions = getNormalizeModuleFederationOptions();
  const { name, filename, getPublicPath, manifest: manifestOptions, varFilename } = mfOptions;

  let mfManifestName =
    manifestOptions === true
      ? 'mf-manifest.json'
      : typeof manifestOptions === 'object'
        ? path.join(
            manifestOptions?.filePath || '',
            manifestOptions?.fileName || 'mf-manifest.json'
          )
        : undefined;

  let mfManifestStatsName = mfManifestName ? getStatsFileName(mfManifestName) : undefined;
  const isConsumerProject = Object.keys(mfOptions.exposes).length === 0;
  let disableAssetsAnalyze = false;

  const getDefaultDisableAssetsAnalyze = (command: string | undefined) =>
    command === 'serve' &&
    isConsumerProject &&
    (typeof manifestOptions !== 'object' ||
      !Object.prototype.hasOwnProperty.call(manifestOptions, 'disableAssetsAnalyze'));

  const getConfiguredDisableAssetsAnalyze = (command: string | undefined) => {
    if (typeof manifestOptions === 'object' && manifestOptions !== null) {
      if (Object.prototype.hasOwnProperty.call(manifestOptions, 'disableAssetsAnalyze')) {
        return manifestOptions.disableAssetsAnalyze === true;
      }
    }
    return getDefaultDisableAssetsAnalyze(command);
  };

  let root: string;
  let remoteEntryFile: string;
  let ssrRemoteEntryFile: string;
  let publicPath: string;
  let _command: string;
  let _originalConfigBase: string | undefined;
  let viteConfig: any;

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
          const devRemoteEntryFile = resolveDevRemoteEntryFileName(filename);
          if (
            devRemoteEntryFile !== filename &&
            Object.keys(mfOptions.exposes).length > 0 &&
            req.url?.startsWith((viteConfig.base + devRemoteEntryFile).replace(/^\/?/, '/'))
          ) {
            req.url = req.url.replace(devRemoteEntryFile, filename);
            next();
            return;
          }
          if (!mfManifestName) {
            next();
            return;
          }
          if (
            req.url?.replace(/\?.*/, '') === (viteConfig.base + mfManifestName).replace(/^\/?/, '/')
          ) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');
            void (async () => {
              const manifest = await applyManifestAdditionalData({
                ...generateMFManifest({}, disableAssetsAnalyze),
                id: name,
                name: name,
                metaData: {
                  name: name,
                  type: 'app',
                  buildInfo: { buildVersion: getBuildVersion(), buildName: name },
                  remoteEntry: {
                    name: devRemoteEntryFile,
                    path: '',
                    type: 'module',
                  },
                  ssrRemoteEntry: {
                    name: getSsrRemoteEntryFileName(devRemoteEntryFile),
                    path: '/__mf_ssr__/',
                    type: 'module',
                  },
                  varRemoteEntry: varFilename
                    ? {
                        name: varFilename,
                        path: '',
                        type: 'var',
                      }
                    : undefined,
                  types: resolveTypesMeta(mfOptions.dts),
                  globalName: name,
                  pluginVersion: '0.2.5',
                  publicPath,
                },
              });
              res.end(JSON.stringify(manifest));
            })().catch(next);
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
        _command = command;
        if (!config.build) config.build = {};
        if (!config.build.manifest) {
          config.build.manifest = config.build.manifest || !!mfManifestName;
        }
        disableAssetsAnalyze = getConfiguredDisableAssetsAnalyze(command);
        _originalConfigBase = config.base;
      },
      configResolved(config) {
        viteConfig = config;
        root = config.root;
        let base = config.base;
        if (_command === 'serve') {
          base = (config.server.origin || '') + config.base;
        }
        // resolvePublicPath treats "auto" as unset to avoid broken concatenation
        // in dev code generation (e.g. "auto" + "remoteEntry.js" → "autoremoteEntry.js").
        // For the manifest, "auto" is a valid sentinel the MF runtime understands,
        // so we preserve it here before falling back to the resolver.
        publicPath =
          mfOptions.publicPath === 'auto'
            ? 'auto'
            : resolvePublicPath(mfOptions, base, _originalConfigBase);
      },
      /**
       * Generates the module federation manifest file
       * @param options - Rollup output options
       * @param bundle - Generated bundle assets
       */
      async generateBundle(_options, bundle) {
        if (!mfManifestName) return;

        // A multi-environment build runs generateBundle once per environment.
        // The SSR manifest references chunks that externalize framework
        // dependencies, so it must not overwrite the browser-safe manifest
        // emitted by the client environment into the public output directory.
        if (this.environment?.name === 'ssr') return;

        let filesMap: PreloadMap = {};

        const foundRemoteEntryFile = findRemoteEntryFile(mfOptions.filename, bundle);
        const expectedSsrRemoteEntryFile = getSsrRemoteEntryFileName(
          foundRemoteEntryFile || mfOptions.filename
        );
        const foundSsrRemoteEntryFile = Object.values(bundle).find(
          (file) => file.fileName === expectedSsrRemoteEntryFile
        )?.fileName;

        // First pass: Find remoteEntry file
        if (foundRemoteEntryFile) {
          remoteEntryFile = foundRemoteEntryFile;
        }
        ssrRemoteEntryFile =
          foundSsrRemoteEntryFile ||
          (_command === 'serve'
            ? getSsrRemoteEntryFileName(resolveDevRemoteEntryFileName(mfOptions.filename))
            : expectedSsrRemoteEntryFile);

        // Second pass: Collect all CSS assets
        const allCssAssets =
          mfOptions.bundleAllCSS && !disableAssetsAnalyze
            ? collectCssAssets(bundle)
            : new Set<string>();

        if (!disableAssetsAnalyze) {
          const exposesModules = Object.keys(mfOptions.exposes).map(
            (item) => mfOptions.exposes[item].import
          );

          // Process exposed modules
          processModuleAssets(
            bundle,
            filesMap,
            (modulePath) => {
              return exposesModules.find((exposeModule) => {
                const exposePath = path.resolve(root, exposeModule);
                return modulePath === exposePath;
              });
            },
            { root, stripKnownJsExtensions: true }
          );

          // Process shared modules
          const fileToShareKey = await buildFileToShareKeyMap(
            getUsedShares(),
            this.resolve.bind(this)
          );
          processModuleAssets(bundle, filesMap, (modulePath) => fileToShareKey.get(modulePath));

          // Add all CSS assets to every export if bundleAllCSS is enabled
          if (mfOptions.bundleAllCSS) {
            addCssAssetsToAllExports(filesMap, allCssAssets);
          }

          // Final deduplication of all assets
          filesMap = deduplicateAssets(filesMap);
        }

        const manifest = await applyManifestAdditionalData(
          generateMFManifest(filesMap, disableAssetsAnalyze),
          undefined
        );

        this.emitFile({
          type: 'asset',
          fileName: mfManifestName,
          source: JSON.stringify(manifest),
        });

        if (mfManifestStatsName) {
          const stats = await applyManifestAdditionalData(
            generateMFStats(manifest, filesMap, bundle, disableAssetsAnalyze),
            manifest
          );

          this.emitFile({
            type: 'asset',
            fileName: mfManifestStatsName,
            source: JSON.stringify(stats),
          });
        }
      },
    },
  ];

  /**
   * Generates the final manifest JSON structure
   * @param preloadMap - Map of module assets to include
   * @returns Complete manifest object
   */
  function generateMFManifest(preloadMap: PreloadMap, disableAssetsAnalyze = false) {
    const options = getNormalizeModuleFederationOptions();
    const { name, varFilename } = options;
    const resolvedRemoteEntryFile =
      _command === 'serve'
        ? remoteEntryFile || resolveDevRemoteEntryFileName(filename)
        : remoteEntryFile;
    const remoteEntry = {
      name: resolvedRemoteEntryFile,
      path: '',
      type: 'module',
    };
    const ssrRemoteEntry = {
      name:
        ssrRemoteEntryFile ||
        getSsrRemoteEntryFileName(
          _command === 'serve' ? resolveDevRemoteEntryFileName(filename) : filename
        ),
      path: _command === 'serve' ? '/__mf_ssr__/' : '',
      type: 'module',
    };

    const varRemoteEntry = varFilename
      ? {
          name: varFilename,
          path: '',
          type: 'var',
        }
      : undefined;

    // Process remotes
    const remotes = Array.from(Object.entries(getUsedRemotesMap())).flatMap(
      ([remoteKey, modules]) => {
        const remote = options.remotes[remoteKey];
        return Array.from(modules).map((moduleKey) => ({
          federationContainerName: getRemoteContainerName(remoteKey, remote),
          moduleName: moduleKey.replace(remoteKey, '').replace('/', ''),
          alias: remoteKey,
          entry: '*',
        }));
      }
    );

    // Process shared dependencies
    const shared = Array.from(getUsedShares()).flatMap((shareKey) => {
      const shareItem = getNormalizeShareItem(shareKey);
      // shareItem can be undefined when a key was added to usedShares before
      // excludeSharedSubDependencies removed it from options.shared in dev mode.
      if (!shareItem) return [];
      const assets =
        preloadMap[shareKey] ||
        (_command === 'serve' && resolvedRemoteEntryFile
          ? createRemoteEntryAssetMap(resolvedRemoteEntryFile)
          : createEmptyAssetMap());

      return [
        {
          id: `${name}:${shareKey}`,
          name: shareKey,
          version: shareItem.version,
          singleton: shareItem.shareConfig.singleton,
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
        },
      ];
    });

    // Process exposed modules
    const exposes = Object.entries(options.exposes).map(([key, value]) => {
      const formatKey = key.replace('./', '');
      const sourceFile = value.import;
      const assets =
        preloadMap[sourceFile] ||
        (_command === 'serve' && resolvedRemoteEntryFile
          ? createRemoteEntryAssetMap(resolvedRemoteEntryFile)
          : createEmptyAssetMap());

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
    });

    return {
      id: name,
      name,
      metaData: {
        name,
        type: 'app',
        buildInfo: {
          buildVersion: getBuildVersion(),
          buildName: name,
        },
        remoteEntry,
        ssrRemoteEntry,
        varRemoteEntry,
        types: resolveTypesMeta(options.dts),
        globalName: name,
        pluginVersion: '0.2.5',
        ...(!!getPublicPath ? { getPublicPath } : { publicPath }),
      },
      ...(disableAssetsAnalyze ? {} : { shared }),
      remotes,
      ...(disableAssetsAnalyze ? {} : { exposes }),
    };
  }

  function generateMFStats(
    manifest: Record<string, any>,
    preloadMap: PreloadMap,
    bundle: Record<string, { [key: string]: any }>,
    disableAssetsAnalyze = false
  ) {
    const bundleSummary = Object.entries(bundle).map(([fileName, chunkOrAsset]) => ({
      fileName,
      type: chunkOrAsset.type,
      isEntry: chunkOrAsset.isEntry || false,
      size:
        typeof chunkOrAsset.code === 'string'
          ? chunkOrAsset.code.length
          : chunkOrAsset.source?.length || undefined,
    }));

    return {
      ...manifest,
      buildOutput: bundleSummary,
      ...(disableAssetsAnalyze ? {} : { assetAnalysis: preloadMap }),
    };
  }

  async function applyManifestAdditionalData(
    stats: Record<string, any>,
    manifest?: Record<string, any>
  ) {
    if (
      typeof manifestOptions !== 'object' ||
      typeof manifestOptions.additionalData !== 'function'
    ) {
      return stats;
    }

    const nextStats = await manifestOptions.additionalData({
      stats,
      manifest,
      pluginOptions: mfOptions as unknown as Record<string, unknown>,
      compiler: undefined,
      compilation: undefined,
      bundler: 'vite',
    });

    return nextStats || stats;
  }
};

function getStatsFileName(manifestFileName: string) {
  const parsed = path.parse(manifestFileName);
  const fileExt = parsed.ext || '.json';
  const baseName = parsed.ext ? parsed.name : parsed.base;
  const baseWithoutManifestSuffix = baseName === 'mf-manifest' ? 'mf' : baseName;
  const fileName = `${baseWithoutManifestSuffix}-stats${fileExt}`;

  return parsed.dir ? path.join(parsed.dir, fileName) : fileName;
}

export default Manifest;
