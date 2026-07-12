import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL } from 'url';
import type { Plugin, ResolvedConfig, UserConfig, ViteDevServer } from 'vite';
import { mfWarn } from '../utils/logger';
import {
  getNormalizeModuleFederationOptions,
  type NormalizedShared,
  type ShareItem,
} from '../utils/normalizeModuleFederationOptions';
import {
  getCommonSharedSubpathFromNodeModulePath,
  getCommonSharedSubpaths,
  getMatchingNodeModuleSubpath,
  isNodeModulePath,
  isAssetLikeImport,
  normalizeNodeModulePath,
} from '../utils/pathNormalization';
import {
  getIsRolldown,
  getInstalledPackageJson,
  getInstalledPackageEntry,
  getPackageDetectionCwd,
  getPackageName,
  getPackageNameFromNodeModulePath,
  hasPackageDependency,
  setPackageDetectionCwd,
} from '../utils/packageUtils';
import { PromiseStore } from '../utils/PromiseStore';
import VirtualModule, { assertModuleFound } from '../utils/VirtualModule';
import {
  collectTreeShakingImports,
  markTreeShakingPackageUnsafe,
  recordTreeShakingExports,
  resetTreeShakingExports,
  setTreeShakingBuildMode,
} from '../utils/treeShaking';
import {
  addUsedShares,
  addTreeShakingGraphQuery,
  getConcreteSharedImportSource,
  generateLocalSharedImportMap,
  getPreBuildShareItem,
  getLoadShareModulePath,
  getLocalSharedImportMapPath,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  refreshHostAutoInit,
  getResolvedLocalSharedImportMapId,
  getTreeShakingSharedProviderImportId,
  getTreeShakingSharedProviderName,
  getTreeShakingGraphToken,
  hasTreeShakingSharedProvider,
  getUsedShares,
  setLocalSharedImportMapInvalidator,
  writeLoadShareModule,
  writeLocalSharedImportMap,
  writePreBuildLibPath,
  refreshTreeShakingModules,
  stripTreeShakingGraphQuery,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

function getPrebuildResolutionSource(pkgName: string, shareItem?: ShareItem): string {
  return getConcreteSharedImportSource(pkgName, shareItem) || pkgName;
}

function tryResolveFromProjectRoot(source: string): string | undefined {
  if (path.isAbsolute(source) || source.startsWith('.') || source.startsWith('/')) return source;
  const browserEntry = getInstalledPackageEntry(source, { cwd: getPackageDetectionCwd() });
  if (browserEntry) return browserEntry;
  try {
    const projectRequire = createRequire(
      pathToFileURL(path.join(getPackageDetectionCwd(), 'package.json'))
    );
    return projectRequire.resolve(source);
  } catch {
    return undefined;
  }
}

function isBuildConfigImporter(importer: string | undefined): boolean {
  if (!importer) return false;
  return /(^|\/)(?:nuxt|vite|vitest|webpack|rollup|rspack)\.config\.[cm]?[jt]sx?$/.test(
    importer.replace(/\\/g, '/')
  );
}

export function matchesSharedSource(source: string, key: string): boolean {
  const keyBase = key.endsWith('/') ? key.slice(0, -1) : key;
  if (
    keyBase === 'vue' &&
    (source === 'vue/dist/vue.esm-bundler.js' || source === 'vue/dist/vue.runtime.esm-bundler.js')
  ) {
    return true;
  }
  if (key.endsWith('/')) return source === keyBase || source.startsWith(`${keyBase}/`);
  if (getCommonSharedSubpaths(keyBase).includes(source)) return true;
  return source === keyBase;
}

export function findSharedKey(
  source: string,
  shared: NormalizedShared | undefined
): string | undefined {
  return getSharedKeyMatcher(shared).find(source);
}

type SharedKeyMatcher = {
  find(source: string): string | undefined;
};

const emptySharedKeyMatcher: SharedKeyMatcher = {
  find: () => undefined,
};

const sharedKeyMatcherCache = new WeakMap<NormalizedShared, SharedKeyMatcher>();

function getSharedKeyMatcher(shared: NormalizedShared | undefined): SharedKeyMatcher {
  if (!shared) return emptySharedKeyMatcher;

  const cached = sharedKeyMatcherCache.get(shared);
  if (cached) return cached;

  // Shared matching is on a hot resolve path. Precompute exact/subpath indexes
  // once per normalized shared object, then cache repeated source lookups.
  const keys = Object.keys(shared);
  const exactKeys = new Set(keys);
  const commonSubpathKeys = new Map<string, string>();
  const wildcardKeys: Array<{ key: string; base: string }> = [];
  let vueKey: string | undefined;

  for (const key of keys) {
    const keyBase = key.endsWith('/') ? key.slice(0, -1) : key;

    if (!vueKey && keyBase === 'vue') vueKey = key;
    if (key.endsWith('/')) wildcardKeys.push({ key, base: keyBase });

    for (const subpath of getCommonSharedSubpaths(keyBase)) {
      if (!commonSubpathKeys.has(subpath)) commonSubpathKeys.set(subpath, key);
    }
  }

  const sourceCache = new Map<string, string | undefined>();
  const matcher: SharedKeyMatcher = {
    find(source) {
      if (sourceCache.has(source)) return sourceCache.get(source);

      let result = exactKeys.has(source) ? source : undefined;

      if (!result && vueKey) {
        if (
          source === 'vue/dist/vue.esm-bundler.js' ||
          source === 'vue/dist/vue.runtime.esm-bundler.js'
        ) {
          result = vueKey;
        }
      }

      if (!result) result = commonSubpathKeys.get(source);

      if (!result) {
        const wildcardKey = wildcardKeys.find(
          ({ base }) => source === base || source.startsWith(`${base}/`)
        );
        result = wildcardKey?.key;
      }

      sourceCache.set(source, result);
      return result;
    },
  };

  sharedKeyMatcherCache.set(shared, matcher);
  return matcher;
}

function findSharedKeyForSource(
  source: string,
  shared: NormalizedShared | undefined
): string | undefined {
  const key = findSharedKey(source, shared);
  if (key) return key;
  const explicitSharedSubpathKeys = Object.keys(shared || {}).filter(
    (sharedKey) => getPackageName(sharedKey) !== sharedKey && !sharedKey.endsWith('/')
  );

  if (isNodeModulePath(source)) {
    const explicitSubpathKey = getMatchingNodeModuleSubpath(source, explicitSharedSubpathKeys);
    if (explicitSubpathKey) return explicitSubpathKey;

    const normalizedSource = normalizeNodeModulePath(source);
    const explicitSubpathEntryKey = explicitSharedSubpathKeys.find((sharedKey) => {
      const entry = getInstalledPackageEntry(sharedKey, { cwd: getPackageDetectionCwd() });
      return entry ? normalizeNodeModulePath(entry) === normalizedSource : false;
    });
    if (explicitSubpathEntryKey) return explicitSubpathEntryKey;
  }

  const packageName = getPackageNameFromNodeModulePath(source);
  return packageName ? findSharedKey(packageName, shared) : undefined;
}

/**
 * Reads the dependencies of an installed package from its package.json.
 */
function getPackageDependencies(pkg: string): string[] {
  const packageName = getPackageName(pkg);
  const installed = getInstalledPackageJson(packageName, { packageName });
  return Object.keys((installed?.packageJson.dependencies as Record<string, string>) || {});
}

/**
 * In dev mode, detects shared packages that are sub-dependencies of other
 * shared packages and removes them to avoid initialization order issues.
 * For example, `lit` depends on `lit-html`, `lit-element`, and
 * `@lit/reactive-element` — sharing them separately causes the child modules
 * to load before their parent, resulting in `undefined` class extends errors.
 */
function excludeSharedSubDependencies(shared: NormalizedShared): void {
  const sharedKeys = new Set(Object.keys(shared));
  const sharedKeyByBase = new Map(
    Object.keys(shared).map((key) => [key.endsWith('/') ? key.slice(0, -1) : key, key])
  );

  for (const parentKey of sharedKeys) {
    const deps = getPackageDependencies(parentKey);
    for (const dep of deps) {
      const depKey = sharedKeyByBase.get(dep);
      if (depKey && depKey !== parentKey) {
        if (
          shared[depKey]?.shareConfig.singleton === true ||
          shared[depKey]?.shareConfig.import === false
        ) {
          continue;
        }

        mfWarn(
          `"${dep}" is a dependency of shared package "${parentKey}" and is also shared separately. ` +
            `This may cause initialization order issues in dev mode. ` +
            `Consider sharing only "${parentKey}".\n` +
            `  Auto-excluding "${dep}" from shared modules for dev mode.`
        );
        delete shared[depKey];
        sharedKeys.delete(depKey);
        sharedKeyByBase.delete(dep);
      }
    }
  }
}

export function proxySharedModule(options: {
  shared?: NormalizedShared;
  include?: string | string[];
  exclude?: string | string[];
}): Plugin[] {
  const { shared = {} } = options;
  let _config: ResolvedConfig | undefined;
  let _command = 'serve';
  let useDirectReactImport = false;
  let useRolldown = false;
  const savePrebuild = new PromiseStore<string>();
  let devServer: ViteDevServer | undefined;
  // resolveId fires once per importing module. The loadShare virtual module,
  // prebuild path, import map, and host-auto-init are a pure function of the
  // shared source, so regenerating them on every resolution is redundant — a
  // singleton imported by N modules would rewrite all of it N times. Track which
  // sources have been materialized so the heavy writes happen at most once each.
  const materializedLoadShareSources = new Set<string>();
  const emittedTreeShakingProviders = new Set<string>();

  const normalizeTreeShakingOutputPath = (value: string) => {
    const normalized = value.replace(/\\/g, '/');
    if (
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(
        `Invalid treeShakingDir "${value}": absolute paths and parent segments are not allowed.`
      );
    }
    let start = normalized.startsWith('./') ? 2 : 0;
    let end = normalized.length;
    while (start < end && normalized.charCodeAt(start) === 47) start++;
    while (end > start && normalized.charCodeAt(end - 1) === 47) end--;
    return normalized.slice(start, end);
  };

  const getTreeShakingProviderFileName = (pkg: string, shareItem: ShareItem) => {
    const treeShaking = shareItem.shareConfig.treeShaking;
    if (!treeShaking) return undefined;

    const normalizedOptions = getNormalizeModuleFederationOptions();
    const outputDir = normalizedOptions.treeShakingDir
      ? normalizeTreeShakingOutputPath(normalizedOptions.treeShakingDir)
      : undefined;

    const fileName = outputDir
      ? path.posix.join(outputDir, `${getTreeShakingSharedProviderName(pkg)}.js`)
      : undefined;

    if (!fileName) return undefined;
    return fileName;
  };

  const emitTreeShakingProvider = (
    context: { emitFile: (file: any) => string },
    pkg: string,
    shareItem: ShareItem
  ) => {
    if (_command !== 'build' || emittedTreeShakingProviders.has(pkg)) return;
    if (!hasTreeShakingSharedProvider(pkg, shareItem)) return;

    const fileName = getTreeShakingProviderFileName(pkg, shareItem);
    context.emitFile({
      type: 'chunk',
      id: getTreeShakingSharedProviderImportId(pkg),
      name: getTreeShakingSharedProviderName(pkg),
      ...(fileName ? { fileName } : {}),
    });
    emittedTreeShakingProviders.add(pkg);
  };

  return [
    {
      name: 'generateLocalSharedImportMap',
      enforce: 'post',
      configureServer(server) {
        devServer = server;
        setLocalSharedImportMapInvalidator(() => {
          const module = server.moduleGraph.getModuleById(getResolvedLocalSharedImportMapId());
          if (module) server.moduleGraph.invalidateModule(module);
        });
      },
      resolveId(source) {
        if (source === getLocalSharedImportMapPath()) {
          return getResolvedLocalSharedImportMapId();
        }
      },
      load(id) {
        if (id === getResolvedLocalSharedImportMapId()) {
          return parsePromise.then((_) => {
            // Export analysis is additive across the module graph. Materialize
            // and emit optimized providers only when the shared map itself is
            // finalized, immediately before Rollup discovers their imports.
            refreshTreeShakingModules();
            const providerPackages = new Set([
              ...Object.keys(shared).filter((pkg) => !pkg.endsWith('/')),
              ...getUsedShares(),
            ]);
            for (const pkg of providerPackages) {
              const sharedKey = findSharedKeyForSource(pkg, shared);
              const shareItem = shared[pkg] || (sharedKey ? shared[sharedKey] : undefined);
              if (shareItem) emitTreeShakingProvider(this, pkg, shareItem);
            }
            return generateLocalSharedImportMap();
          });
        }
      },
      closeBundle() {
        if (devServer) return;
        setLocalSharedImportMapInvalidator(undefined);
      },
    },
    {
      name: 'proxyPreBuildShared',
      enforce: 'post',
      config(config: UserConfig, { command }) {
        const root = config.root || process.cwd();
        setPackageDetectionCwd(root);
        setTreeShakingBuildMode(command === 'build');
        resetTreeShakingExports();
        emittedTreeShakingProviders.clear();
        const isVinext = hasPackageDependency('vinext');
        const isAstro = hasPackageDependency('astro');
        const isRolldown = getIsRolldown(this);
        _command = command;
        useRolldown = isRolldown;
        useDirectReactImport = isVinext || isAstro;

        if (command === 'serve') {
          excludeSharedSubDependencies(shared);
        }
      },
      configResolved(config) {
        _config = config;

        // Write virtual module files and register shares eagerly.
        // The deadlock that previously occurred here (localSharedImportMap
        // referencing prebuild modules → Vite re-optimization → deadlock)
        // is now prevented by adding prebuild IDs to optimizeDeps.include
        // in the config hook (createEarlyVirtualModulesPlugin), so Vite
        // pre-bundles them upfront without triggering re-optimization.
        const isRolldown = getIsRolldown(this);
        Object.keys(shared).forEach((key) => {
          if (key.endsWith('/')) return;
          if (useDirectReactImport && key === 'react') {
            addUsedShares(key);
            return;
          }
          writeLoadShareModule(key, shared[key], _command, isRolldown);
          // Skip prebuild for shared deps with import: false — the host must
          // provide them, so no local fallback source is needed.
          if (shared[key].shareConfig.import !== false) {
            writePreBuildLibPath(key, shared[key]);
          }
          addUsedShares(key);
        });
        writeLocalSharedImportMap();
        refreshHostAutoInit();
      },
      buildStart() {
        if (_command !== 'build') return;
        resetTreeShakingExports();
        emittedTreeShakingProviders.clear();
        refreshTreeShakingModules();
      },
      shouldTransformCachedModule() {
        // Watch builds must revisit cached importers after the per-build usage
        // map is reset, otherwise only changed files contribute usedExports.
        return (
          _command === 'build' &&
          Object.values(shared).some((share) => !!share.shareConfig.treeShaking)
        );
      },
      transform(code, id) {
        if (
          _command !== 'build' ||
          !Object.keys(shared).some((key) => shared[key].shareConfig.treeShaking)
        ) {
          return;
        }
        collectTreeShakingImports(
          code,
          id,
          shared,
          findSharedKeyForSource,
          recordTreeShakingExports,
          markTreeShakingPackageUnsafe
        );
        refreshTreeShakingModules();
      },
    },
    {
      name: 'proxyPreBuildShared:tree-shaking-graph',
      enforce: 'pre',
      apply: 'build',
      async resolveId(source, importer, resolveOptions) {
        const sourceToken = getTreeShakingGraphToken(source);
        const importerToken = getTreeShakingGraphToken(importer);
        const token = sourceToken || importerToken;
        if (!token) return;

        const cleanSource = stripTreeShakingGraphQuery(source);
        const cleanImporter = importer ? stripTreeShakingGraphQuery(importer) : undefined;

        // Dependencies that are independently configured as shared keep using
        // their ordinary federation wrapper. Everything else inherits the
        // graph token so the optimized provider cannot be merged with the full
        // fallback's dependency graph.
        if (!sourceToken && importerToken) {
          const nestedSharedKey = findSharedKeyForSource(cleanSource, shared);
          if (
            nestedSharedKey &&
            getPackageName(nestedSharedKey) !== getPackageName(importerToken)
          ) {
            return this.resolve(cleanSource, cleanImporter, {
              ...resolveOptions,
              skipSelf: true,
            });
          }
        }

        const projectResolvedSource = sourceToken
          ? tryResolveFromProjectRoot(cleanSource) || cleanSource
          : cleanSource;
        const resolved = await this.resolve(projectResolvedSource, cleanImporter, {
          ...resolveOptions,
          custom: {
            ...resolveOptions.custom,
            __mfTreeShakingGraph: true,
          },
          skipSelf: true,
        });
        if (!resolved || resolved.external) return resolved;
        // Bundler/plugin virtual modules generally require an exact id in their
        // load hook (for example Vite's preload helper). Appending an unknown
        // query would make them unloadable; their own implementation is build
        // infrastructure rather than part of the shared package graph.
        if (resolved.id.startsWith('\0')) return resolved;

        return {
          ...resolved,
          id: addTreeShakingGraphQuery(resolved.id, token),
        };
      },
    },
    {
      name: 'proxyPreBuildShared:resolve-shared-loadShare',
      enforce: 'pre',
      async resolveId(source, importer, resolveOptions) {
        if ((resolveOptions.custom as Record<string, unknown> | undefined)?.__mfTreeShakingGraph) {
          return;
        }
        function shouldSkipTaggedImporterProxy(sharedKey: string, tag: string): boolean {
          if (!importer?.includes(tag)) return false;

          const taggedModule = VirtualModule.findModule(tag, importer);
          if (!taggedModule) return true;

          // Only skip a wrapper's own fallback import. Cross-wrapper shared imports
          // still need proxying, e.g. @fortawesome/vue-fontawesome -> vue.
          return taggedModule.name === sharedKey || matchesSharedSource(source, taggedModule.name);
        }

        const key = findSharedKeyForSource(source, shared);
        if (!key) return;
        if (useDirectReactImport && key === 'react') return;
        if (isAssetLikeImport(source)) return;
        if (isBuildConfigImporter(importer)) return;
        // Hard-stop proxying bare React in dev. Vite's RSC pipeline expects
        // the native server React entry.
        if (useDirectReactImport && source === 'react') return;
        // Avoid recursive loadShare/prebuild/local map resolution loops.
        if (importer && importer.includes('localSharedImportMap')) return;
        if (importer && (importer.includes('hostAutoInit') || importer.includes('__H_A_I__'))) {
          return;
        }
        if (shouldSkipTaggedImporterProxy(key, LOAD_SHARE_TAG)) return;
        if (shouldSkipTaggedImporterProxy(key, PREBUILD_TAG)) return;
        const shareSource =
          key === 'vue' && source.startsWith('vue/dist/')
            ? key
            : isNodeModulePath(source)
              ? getCommonSharedSubpathFromNodeModulePath(source, key) || key
              : source;
        const loadSharePath = getLoadShareModulePath(shareSource, useRolldown);
        if (!materializedLoadShareSources.has(shareSource)) {
          materializedLoadShareSources.add(shareSource);
          writeLoadShareModule(shareSource, shared[key], _command, useRolldown);
          if (shared[key].shareConfig.import !== false) {
            writePreBuildLibPath(shareSource, shared[key]);
          }
          addUsedShares(shareSource);
          writeLocalSharedImportMap();
          refreshHostAutoInit();
        }
        return this.resolve(loadSharePath, importer, { skipSelf: true });
      },
    },
    {
      name: 'proxyPreBuildShared:resolve-prebuild',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!source.includes(PREBUILD_TAG)) return;
        if (source.startsWith('.')) return;

        const module = assertModuleFound(PREBUILD_TAG, source) as VirtualModule;
        const pkgName = module.name;
        const importSource = getPrebuildResolutionSource(pkgName, getPreBuildShareItem(pkgName));

        if (_command === 'build') {
          return this.resolve(importSource, importer, { skipSelf: true });
        }

        const direct = tryResolveFromProjectRoot(importSource);
        const directSource = direct && !isNodeModulePath(direct) ? direct : undefined;
        const resolved = await this.resolve(directSource || importSource, importer, {
          skipSelf: true,
        });
        if (!resolved?.id) return;
        const result = resolved.id;
        if (!_config || result.includes(_config.cacheDir)) {
          if (directSource) {
            return (
              (await this.resolve(directSource, importer, { skipSelf: true })) || {
                id: directSource,
              }
            );
          }
          return resolved;
        }
        // save pre-bunding module id
        savePrebuild.set(pkgName, Promise.resolve(result));
        // Fix localSharedImportMap import id
        return await this.resolve(await savePrebuild.get(pkgName), importer, { skipSelf: true });
      },
    },
  ];
}
