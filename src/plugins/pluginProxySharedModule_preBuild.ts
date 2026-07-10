import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL } from 'url';
import type { Plugin, ResolvedConfig, UserConfig, ViteDevServer } from 'vite';
import { mfWarn } from '../utils/logger';
import type { NormalizedShared, ShareItem } from '../utils/normalizeModuleFederationOptions';
import {
  getCommonSharedSubpathFromNodeModulePath,
  getCommonSharedSubpaths,
  getMatchingNodeModuleSubpath,
  isNodeModulePath,
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
  addUsedShares,
  getConcreteSharedImportSource,
  generateLocalSharedImportMap,
  getPreBuildShareItem,
  getLoadShareModulePath,
  getLocalSharedImportMapPath,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  refreshHostAutoInit,
  getResolvedLocalSharedImportMapId,
  setLocalSharedImportMapInvalidator,
  writeLoadShareModule,
  writeLocalSharedImportMap,
  writePreBuildLibPath,
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
          return parsePromise.then((_) => generateLocalSharedImportMap());
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
    },
    {
      name: 'proxyPreBuildShared:resolve-shared-loadShare',
      enforce: 'pre',
      async resolveId(source, importer) {
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
        if (
          /\.(?:css|scss|sass|less|styl|stylus|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm)(?:[?#].*)?$/i.test(
            source
          )
        )
          return;
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
