import { getPreBuildLibImportId } from '../virtualModules';

export type OutputBundleItem = {
  type: 'chunk' | 'asset';
  name?: string;
  fileName: string;
  modules?: Record<string, unknown> | undefined;
  dynamicImports?: string[] | undefined;
};

export const ASSET_TYPES = ['js', 'css'] as const;
export const LOAD_TIMINGS = ['sync', 'async'] as const;
export const JS_EXTENSIONS = ['.ts', '.tsx', '.jsx', '.mjs', '.cjs'] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type AssetMap = {
  sync: string[];
  async: string[];
};

export type PreloadMap = Record<
  string,
  {
    [K in (typeof ASSET_TYPES)[number]]: AssetMap;
  }
>;

/**
 * Creates an empty asset map structure for tracking JS and CSS assets
 * @returns Initialized asset map with sync/async arrays for JS and CSS
 */
export const createEmptyAssetMap = (): { js: AssetMap; css: AssetMap } => ({
  js: { sync: [], async: [] },
  css: { sync: [], async: [] },
});

/**
 * Tracks an asset in the preload map with deduplication
 * @param map - The preload map to update
 * @param key - The module key to track under
 * @param fileName - The asset filename to track
 * @param isAsync - Whether the asset is loaded async
 * @param type - The asset type ('js' or 'css')
 */
export const trackAsset = (
  map: PreloadMap,
  key: string,
  fileName: string,
  isAsync: boolean,
  type: AssetType
) => {
  if (!map[key]) {
    map[key] = createEmptyAssetMap();
  }
  const target = isAsync ? map[key][type].async : map[key][type].sync;
  if (!target.includes(fileName)) {
    target.push(fileName);
  }
};

/**
 * Checks if a file is a CSS file by extension
 * @param fileName - The filename to check
 * @returns True if file has a CSS extension (.css, .scss, .less)
 */
export const isCSSFile = (fileName: string): boolean => {
  return fileName.endsWith('.css') || fileName.endsWith('.scss') || fileName.endsWith('.less');
};

/**
 * Collects all CSS assets from the bundle
 * @param bundle - The Rollup output bundle
 * @returns Set of CSS asset filenames
 */
export const collectCssAssets = (bundle: Record<string, OutputBundleItem>): Set<string> => {
  const cssAssets = new Set<string>();
  for (const [fileName, fileData] of Object.entries(bundle)) {
    if (fileData.type === 'asset' && isCSSFile(fileName)) {
      cssAssets.add(fileName);
    }
  }
  return cssAssets;
};

/**
 * Processes module assets and tracks them in the files map
 * @param bundle - The Rollup output bundle
 * @param filesMap - The preload map to populate
 * @param moduleMatcher - Function that matches module paths to keys
 */
export const processModuleAssets = (
  bundle: Record<string, OutputBundleItem>,
  filesMap: PreloadMap,
  moduleMatcher: (modulePath: string) => string | undefined
) => {
  for (const [fileName, fileData] of Object.entries(bundle)) {
    if (fileData.type !== 'chunk') continue;

    if (!fileData.modules) continue;

    for (const modulePath of Object.keys(fileData.modules)) {
      const matchKey = moduleMatcher(modulePath);
      if (!matchKey) continue;

      // Track main JS chunk
      trackAsset(filesMap, matchKey, fileName, false, 'js');

      // Handle dynamic imports
      if (fileData.dynamicImports) {
        for (const dynamicImport of fileData.dynamicImports) {
          const importData = bundle[dynamicImport];
          if (!importData) continue;

          const isCss = isCSSFile(dynamicImport);
          trackAsset(filesMap, matchKey, dynamicImport, true, isCss ? 'css' : 'js');
        }
      }
    }
  }
};

/**
 * Adds global CSS assets to all module exports
 * @param filesMap - The preload map to update
 * @param cssAssets - Set of CSS asset filenames to add
 */
export const addCssAssetsToAllExports = (filesMap: PreloadMap, cssAssets: Set<string>) => {
  Object.keys(filesMap).forEach((key) => {
    cssAssets.forEach((cssAsset) => {
      trackAsset(filesMap, key, cssAsset, false, 'css');
    });
  });
};

/**
 * Deduplicates assets in the files map
 * @param filesMap - The preload map to deduplicate
 * @returns New deduplicated preload map
 */
export const deduplicateAssets = (filesMap: PreloadMap): PreloadMap => {
  const result: PreloadMap = {};
  for (const [key, assetMaps] of Object.entries(filesMap)) {
    result[key] = createEmptyAssetMap();
    for (const type of ASSET_TYPES) {
      for (const timing of LOAD_TIMINGS) {
        result[key][type][timing] = Array.from(new Set(assetMaps[type][timing]));
      }
    }
  }
  return result;
};

/**
 * Builds a mapping between module files and their share keys
 * @param shareKeys - Set of share keys to map
 * @param resolveFn - Function to resolve module paths
 * @returns Map of file paths to their corresponding share keys
 */
export const buildFileToShareKeyMap = async (
  shareKeys: Set<string>,
  resolveFn: (id: string) => Promise<{ id: string } | null>
): Promise<Map<string, string>> => {
  const fileToShareKey = new Map<string, string>();

  const resolutions = await Promise.all(
    Array.from(shareKeys).map((shareKey) =>
      resolveFn(getPreBuildLibImportId(shareKey))
        .then((resolution) => ({
          shareKey,
          file: resolution?.id?.split('?')[0],
        }))
        .catch(() => null)
    )
  );

  for (const resolution of resolutions) {
    if (resolution?.file) {
      fileToShareKey.set(resolution.file, resolution.shareKey);
    }
  }

  return fileToShareKey;
};
