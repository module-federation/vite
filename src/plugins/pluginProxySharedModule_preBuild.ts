import { existsSync, readFileSync } from 'fs';
import path from 'pathe';
import { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { mfWarn } from '../utils/logger';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { NormalizedShared, ShareItem } from '../utils/normalizeModuleFederationOptions';
import {
  getIsRolldown,
  getPackageDetectionCwd,
  hasPackageDependency,
  removePathFromNpmPackage,
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
  PREBUILD_TAG,
  writeLoadShareModule,
  writeLocalSharedImportMap,
  writePreBuildLibPath,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

function getPrebuildResolutionSource(pkgName: string, shareItem?: ShareItem): string {
  return getConcreteSharedImportSource(pkgName, shareItem) || pkgName;
}

/**
 * Reads the dependencies of an installed package from its package.json.
 */
function getPackageDependencies(pkg: string): string[] {
  const packageName = removePathFromNpmPackage(pkg);
  const cwd = getPackageDetectionCwd();
  const candidates = [path.join(cwd, 'node_modules', packageName, 'package.json')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const json = JSON.parse(readFileSync(candidate, 'utf-8')) as {
          dependencies?: Record<string, string>;
        };
        return Object.keys(json.dependencies || {});
      } catch {
        // skip
      }
    }
  }
  return [];
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

  for (const parentKey of sharedKeys) {
    const deps = getPackageDependencies(parentKey);
    for (const dep of deps) {
      if (sharedKeys.has(dep) && dep !== parentKey) {
        mfWarn(
          `"${dep}" is a dependency of shared package "${parentKey}" and is also shared separately. ` +
            `This may cause initialization order issues in dev mode. ` +
            `Consider sharing only "${parentKey}".\n` +
            `  Auto-excluding "${dep}" from shared modules for dev mode.`
        );
        delete shared[dep];
        sharedKeys.delete(dep);
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
  const savePrebuild = new PromiseStore<string>();

  return [
    {
      name: 'generateLocalSharedImportMap',
      enforce: 'post',
      load(id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return parsePromise.then((_) => generateLocalSharedImportMap());
        }
      },
      transform(_, id) {
        if (id.includes(getLocalSharedImportMapPath())) {
          return mapCodeToCodeWithSourcemap(
            parsePromise.then((_) => generateLocalSharedImportMap())
          );
        }
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
        useDirectReactImport = isVinext || isAstro;

        if (command === 'serve') {
          excludeSharedSubDependencies(shared);
        }

        (config.resolve as any).alias.push(
          ...Object.keys(shared)
            .filter((key) => !(useDirectReactImport && key === 'react'))
            .map((key) => {
              const keyBase = key.endsWith('/') ? key.slice(0, -1) : key;
              const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const escapedKeyBase = escapeRegex(keyBase);
              // Trailing-slash keys act as package-prefix shares:
              // "react/" should match both "react" and "react/*".
              const pattern = key.endsWith('/')
                ? `^(${escapedKeyBase}(?:\\/.*)?)$`
                : `^(${escapedKeyBase})$`;
              return {
                // Intercept all shared requests and proxy them to loadShare
                find: new RegExp(pattern),
                replacement: '$1',
                customResolver(source: string, importer: string) {
                  if (/\.css$/.test(source)) return;
                  const normalizedImporter = importer?.replace(/\\/g, '/');
                  const isReactCjsImporter =
                    normalizedImporter &&
                    /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?react(?:-dom)?\/cjs\//.test(
                      normalizedImporter
                    );
                  if (
                    isRolldown &&
                    isReactCjsImporter &&
                    (source === 'react' || source === 'react-dom')
                  ) {
                    return;
                  }
                  // Hard-stop proxying bare React in dev. Vite's RSC pipeline
                  // expects the native server React entry, and wrapping `react`
                  // through loadShare breaks react-server-dom-webpack.
                  // We still register React in the federation share scope via
                  // localSharedImportMap, so shared metadata remains available.
                  if (useDirectReactImport && source === 'react') {
                    return;
                  }
                  // Skip for localSharedImportMap to break circular TLA deadlock:
                  // loadShare TLA → runtime.loadShare() → get() → import(prebuild)
                  // → alias to pkg name → shared alias → loadShare (DEADLOCK)
                  if (importer && importer.includes('localSharedImportMap')) {
                    return;
                  }
                  // Trailing-slash keys (e.g. "react/") match subpath imports like
                  // "react/jsx-dev-runtime". However, the MF runtime's loadShare does
                  // exact key lookup — subpath shares aren't registered and loadShare
                  // returns false, causing "factory is not a function". Let subpath
                  // imports resolve normally; the base package singleton sharing
                  // already ensures a single instance.
                  if (key.endsWith('/') && source !== key.slice(0, -1)) {
                    return;
                  }
                  const loadSharePath = getLoadShareModulePath(source, isRolldown, command);
                  writeLoadShareModule(source, shared[key], command, isRolldown);
                  if (shared[key].shareConfig.import !== false) {
                    writePreBuildLibPath(source, shared[key]);
                  }
                  addUsedShares(source);
                  writeLocalSharedImportMap();
                  return (this as any).resolve(loadSharePath, importer);
                },
              };
            })
        );

        (config.resolve as any).alias.push(
          ...Object.keys(shared)
            .filter((key) => !(useDirectReactImport && key === 'react'))
            .map((key) => {
              return command === 'build'
                ? {
                    find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                    replacement: function ($1: string) {
                      const module = assertModuleFound(PREBUILD_TAG, $1) as VirtualModule;
                      const pkgName = module.name;
                      return getPrebuildResolutionSource(pkgName, getPreBuildShareItem(pkgName));
                    },
                  }
                : {
                    find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                    replacement: '$1',
                    async customResolver(source: string, importer: string) {
                      const module = assertModuleFound(PREBUILD_TAG, source) as VirtualModule;
                      const pkgName = module.name;
                      const importSource = getPrebuildResolutionSource(
                        pkgName,
                        getPreBuildShareItem(pkgName)
                      );
                      const resolved = await (this as any).resolve(importSource, importer);
                      if (!resolved?.id) return;
                      const result = resolved.id;
                      if (_config && !result.includes(_config.cacheDir)) {
                        // save pre-bunding module id
                        savePrebuild.set(pkgName, Promise.resolve(result));
                      }
                      // Fix localSharedImportMap import id
                      return await (this as any).resolve(await savePrebuild.get(pkgName), importer);
                    },
                  };
            })
        );
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
      },
    },
  ];
}
