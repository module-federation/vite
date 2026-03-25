import { Plugin, ResolvedConfig, UserConfig } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { NormalizedShared, ShareItem } from '../utils/normalizeModuleFederationOptions';
import { getIsRolldown, hasPackageDependency, setPackageDetectionCwd } from '../utils/packageUtils';
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

export function proxySharedModule(options: {
  shared?: NormalizedShared;
  include?: string | string[];
  exclude?: string | string[];
}): Plugin[] {
  const { shared = {} } = options;
  let _config: ResolvedConfig | undefined;
  let _command = 'serve';
  let isVinext = false;
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
        isVinext = hasPackageDependency('vinext');
        const isRolldown = getIsRolldown(this);
        _command = command;

        (config.resolve as any).alias.push(
          ...Object.keys(shared)
            .filter((key) => !(isVinext && key === 'react'))
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
                  // Hard-stop proxying bare React in dev. Vite's RSC pipeline
                  // expects the native server React entry, and wrapping `react`
                  // through loadShare breaks react-server-dom-webpack.
                  // We still register React in the federation share scope via
                  // localSharedImportMap, so shared metadata remains available.
                  if (isVinext && source === 'react') {
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
            .filter((key) => !(isVinext && key === 'react'))
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
        const isRolldown = !!(config as any).experimental?.rolldownDev;
        Object.keys(shared).forEach((key) => {
          const pkg = key.endsWith('/') ? key.slice(0, -1) : key;
          if (isVinext && pkg === 'react') {
            addUsedShares(pkg);
            return;
          }
          writeLoadShareModule(pkg, shared[key], _command, isRolldown);
          // Skip prebuild for shared deps with import: false — the host must
          // provide them, so no local fallback source is needed.
          if (shared[key].shareConfig.import !== false) {
            writePreBuildLibPath(pkg, shared[key]);
          }
          addUsedShares(pkg);
        });
        writeLocalSharedImportMap();
      },
    },
  ];
}
