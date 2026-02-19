import { Plugin, UserConfig } from 'vite';
import { mapCodeToCodeWithSourcemap } from '../utils/mapCodeToCodeWithSourcemap';
import { NormalizedShared } from '../utils/normalizeModuleFederationOptions';
import { PromiseStore } from '../utils/PromiseStore';
import VirtualModule, { assertModuleFound } from '../utils/VirtualModule';
import {
  addUsedShares,
  generateLocalSharedImportMap,
  getLoadShareModulePath,
  getLocalSharedImportMapPath,
  PREBUILD_TAG,
  writeLoadShareModule,
  writeLocalSharedImportMap,
  writePreBuildLibPath,
} from '../virtualModules';
import { parsePromise } from './pluginModuleParseEnd';

export function proxySharedModule(options: {
  shared?: NormalizedShared;
  include?: string | string[];
  exclude?: string | string[];
}): Plugin[] {
  let { shared = {}, include, exclude } = options;
  let _config: UserConfig;
  // Pre-compiled shared key regex patterns, set in config hook of resolveId plugin
  let sharedPatterns: { key: string; regex: RegExp }[] = [];
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
      configResolved(config) {
        _config = config as any;
      },
      config(config: UserConfig, { command }) {
        // In dev mode, use aliases (resolveId can't interfere with Vite pre-bundling).
        // In build mode, aliases are skipped — resolveId handles resolution instead,
        // so that per-environment scoping (applyToEnvironment) works correctly.
        if (command !== 'build') {
          (config.resolve as any).alias.push(
            ...Object.keys(shared).map((key) => {
              const pattern = key.endsWith('/')
                ? `(^${key.replace(/\/$/, '')}(\/.+)?$)`
                : `(^${key}$)`;
              return {
                // Intercept all shared requests and proxy them to loadShare
                find: new RegExp(pattern),
                replacement: '$1',
                customResolver(source: string, importer: string) {
                  if (/\.css$/.test(source)) return;
                  const loadSharePath = getLoadShareModulePath(source);
                  writeLoadShareModule(source, shared[key], command);
                  writePreBuildLibPath(source);
                  addUsedShares(source);
                  writeLocalSharedImportMap();
                  return (this as any).resolve(loadSharePath, importer);
                },
              };
            })
          );

          const savePrebuild = new PromiseStore<string>();

          (config.resolve as any).alias.push(
            ...Object.keys(shared).map((key) => {
              return {
                find: new RegExp(`(.*${PREBUILD_TAG}.*)`),
                replacement: '$1',
                async customResolver(source: string, importer: string) {
                  const module = assertModuleFound(PREBUILD_TAG, source) as VirtualModule;
                  const pkgName = module.name;
                  const result = await (this as any)
                    .resolve(pkgName, importer)
                    .then((item: any) => item.id);
                  if (!result.includes(_config.cacheDir)) {
                    // save pre-bunding module id
                    savePrebuild.set(pkgName, Promise.resolve(result));
                  }
                  // Fix localSharedImportMap import id
                  return await (this as any).resolve(await savePrebuild.get(pkgName), importer);
                },
              };
            })
          );
        }
      },
    },
    {
      name: 'proxyPreBuildShared:resolve',
      enforce: 'pre',
      apply: 'build',
      config() {
        // Pre-compile shared key regex patterns at config time
        sharedPatterns = Object.keys(shared).map((key) => ({
          key,
          regex: key.endsWith('/')
            ? new RegExp(`^${key.replace(/\/$/, '')}(\/.+)?$`)
            : new RegExp(`^${key}$`),
        }));
      },
      resolveId(source, importer) {
        // 1. Intercept __prebuild__ imports (from inside __loadShare__ files)
        if (source.includes(PREBUILD_TAG)) {
          const module = assertModuleFound(PREBUILD_TAG, source) as VirtualModule;
          const pkgName = module.name;
          return (this as any).resolve(pkgName, importer, { skipSelf: true });
        }

        // 2. Intercept shared dep imports (e.g. 'react', 'react-dom/client')
        if (/\.css$/.test(source)) return;
        for (const { key, regex } of sharedPatterns) {
          if (regex.test(source)) {
            const loadSharePath = getLoadShareModulePath(source);
            writeLoadShareModule(source, shared[key], 'build');
            writePreBuildLibPath(source);
            addUsedShares(source);
            writeLocalSharedImportMap();
            return { id: loadSharePath, syntheticNamedExports: '__moduleExports' };
          }
        }
      },
    } satisfies Plugin,
  ];
}
